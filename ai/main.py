"""Local semantic-search embedding service — Intel NPU / GPU accelerated.

Runs the bge-small-en-v1.5 ONNX model through **OpenVINO** directly (not
onnxruntime/fastembed), with the graph reshaped to a static [1, SEQ_LEN] shape
so it compiles onto the Intel **NPU** (AI Boost). Falls back to the Arc **GPU**
then **CPU** if a device can't compile/run the model. Tokenization is done with
the HF `tokenizers` library; sentence embedding is the CLS token, L2-normalized
(the bge convention). Given a query + documents, /rank returns them ranked by
cosine similarity.

Runs on the Windows host (not Docker) so it can reach the NPU. The API service
in Docker calls it via AI_URL=http://host.docker.internal:8001.
"""
import glob
import hashlib
import os
from contextlib import asynccontextmanager

import numpy as np
import openvino as ov
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from tokenizers import Tokenizer

MODEL_DIR = os.getenv("MODEL_DIR", os.path.join(os.path.dirname(__file__), ".models"))
DEVICES = [d.strip().upper() for d in os.getenv("EMBED_DEVICES", "NPU,GPU,CPU").split(",") if d.strip()]
SEQ_LEN = int(os.getenv("EMBED_SEQ_LEN", "128"))
# BGE retrieves best when the *query* carries this instruction (docs stay as-is).
QUERY_INSTRUCTION = "Represent this sentence for searching relevant passages: "

_state: dict = {
    "compiled": None,
    "tokenizer": None,
    "in_names": None,
    "device": None,
    "corpus_hash": None,
    "corpus_vecs": None,
    "corpus_ids": None,
}


def _find(pattern: str) -> str:
    hits = glob.glob(os.path.join(MODEL_DIR, "**", pattern), recursive=True)
    if not hits:
        raise FileNotFoundError(f"{pattern} not found under {MODEL_DIR}")
    return hits[0]


def _load():
    onnx_path = _find("model_optimized.onnx")
    tok = Tokenizer.from_file(_find("tokenizer.json"))
    tok.enable_truncation(max_length=SEQ_LEN)
    tok.enable_padding(length=SEQ_LEN)

    core = ov.Core()
    core.set_property({"CACHE_DIR": os.path.join(MODEL_DIR, "ov_cache")})
    model = core.read_model(onnx_path)
    in_names = [i.get_any_name() for i in model.inputs]
    # Static shape [1, SEQ_LEN] — required for the NPU.
    model.reshape({n: ov.PartialShape([1, SEQ_LEN]) for n in in_names})

    print(f"[ai] OpenVINO devices: {core.available_devices}", flush=True)
    last_err = None
    for device in DEVICES:
        if device not in core.available_devices:
            print(f"[ai] {device} not present, skipping", flush=True)
            continue
        try:
            compiled = core.compile_model(model, device)
            _state.update(compiled=compiled, tokenizer=tok, in_names=in_names, device=device)
            # Warm up / prove it actually runs on this device.
            _embed(["warmup"])
            print(f"[ai] embeddings running on {device}", flush=True)
            return
        except Exception as e:
            print(f"[ai] {device} failed to run the model: {str(e)[:200]}", flush=True)
            last_err = e
    raise RuntimeError(f"No usable device in {DEVICES}: {last_err}")


def _embed(texts: list[str]) -> np.ndarray:
    compiled, tok, in_names = _state["compiled"], _state["tokenizer"], _state["in_names"]
    out = compiled.output(0)
    vecs = np.empty((len(texts), 384), dtype=np.float32)
    for row, text in enumerate(texts):
        enc = tok.encode(text)
        feeds = {}
        for n in in_names:
            if "attention_mask" in n:
                feeds[n] = np.array([enc.attention_mask], dtype=np.int64)
            elif "token_type" in n:
                feeds[n] = np.zeros((1, SEQ_LEN), dtype=np.int64)
            else:  # input_ids
                feeds[n] = np.array([enc.ids], dtype=np.int64)
        last_hidden = compiled(feeds)[out]  # (1, SEQ_LEN, 384)
        vecs[row] = last_hidden[0, 0]  # CLS token = sentence embedding
    norms = np.linalg.norm(vecs, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return vecs / norms  # L2-normalized → dot product == cosine similarity


@asynccontextmanager
async def lifespan(app: FastAPI):
    _load()
    yield


app = FastAPI(title="ITLedger AI", version="0.3.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


class Doc(BaseModel):
    id: str
    text: str


class RankRequest(BaseModel):
    query: str
    documents: list[Doc]
    top_k: int = 20


class RankResult(BaseModel):
    id: str
    score: float


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "ready": _state["compiled"] is not None,
        "device": _state["device"],
        "seq_len": SEQ_LEN,
    }


@app.post("/rank", response_model=list[RankResult])
async def rank(req: RankRequest):
    if _state["compiled"] is None:
        raise HTTPException(503, "Model still loading")
    if not req.documents:
        return []

    ids = [d.id for d in req.documents]
    texts = [d.text for d in req.documents]

    digest = hashlib.sha1(
        "\x00".join(f"{i}\x01{t}" for i, t in zip(ids, texts)).encode("utf-8")
    ).hexdigest()
    if _state["corpus_hash"] != digest:
        _state["corpus_vecs"] = _embed(texts)
        _state["corpus_ids"] = ids
        _state["corpus_hash"] = digest

    qvec = _embed([QUERY_INSTRUCTION + req.query])[0]
    sims = _state["corpus_vecs"] @ qvec
    order = np.argsort(-sims)[: max(1, req.top_k)]
    return [RankResult(id=_state["corpus_ids"][i], score=float(sims[i])) for i in order]
