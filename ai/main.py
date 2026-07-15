"""Local semantic-search embedding service — Intel NPU / GPU accelerated.

Runs the **multilingual-e5-small** ONNX model through **OpenVINO** directly (not
onnxruntime/fastembed), with the graph reshaped to a static [1, SEQ_LEN] shape
so it compiles onto the Intel **NPU** (AI Boost). Falls back to the Arc **GPU**
then **CPU** if a device can't compile/run the model. Tokenization is done with
the HF `tokenizers` library; the sentence embedding is the attention-masked
**mean** of the token vectors, L2-normalized (the e5 convention). e5 needs the
query prefixed with "query: " and each document with "passage: ". The model is
multilingual (~100 languages incl. Vietnamese) so VN queries rank correctly.
Given a query + documents, /rank returns them ranked by cosine similarity.

Runs on the Windows host via ai/run-host.ps1 (EMBED_DEVICES=NPU,GPU,CPU) so it
can use the Intel NPU; the Dockerized API calls it at
AI_URL=http://host.docker.internal:8001. This service is embedding-only — there
is no generative LLM.
"""
import glob
import hashlib
import os
import re
from contextlib import asynccontextmanager

import numpy as np
import openvino as ov
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from tokenizers import Tokenizer

MODEL_DIR = os.getenv("MODEL_DIR", os.path.join(os.path.dirname(__file__), ".models", "e5-small"))
DEVICES = [d.strip().upper() for d in os.getenv("EMBED_DEVICES", "NPU,GPU,CPU").split(",") if d.strip()]
SEQ_LEN = int(os.getenv("EMBED_SEQ_LEN", "128"))
# multilingual-e5 needs these prefixes: the query as "query: ", each document as
# "passage: ". They matter for retrieval quality — don't drop them.
QUERY_PREFIX = os.getenv("EMBED_QUERY_PREFIX", "query: ")
DOC_PREFIX = os.getenv("EMBED_DOC_PREFIX", "passage: ")
# Hybrid ranking: final = semantic_cosine + LEX_WEIGHT * (query-word overlap).
# The embedder captures meaning but is weak on exact/rare tokens (a serial, a
# brand, "i7"); a light lexical boost floats literal hits up without letting
# keywords dominate meaning. 0 disables it (pure semantic).
LEX_WEIGHT = float(os.getenv("LEX_WEIGHT", "0.18"))
# Unicode-aware so accented Vietnamese words ("màn", "hình") stay whole tokens.
# A plain [a-z0-9]+ would shred them and spuriously boost unrelated rows.
_WORD_RE = re.compile(r"[^\W_]+", re.UNICODE)
# Words too generic to count as evidence of a match.
_STOP = frozenset(
    "a an the of for to in on at by with and or is are be it this that device "
    "laptop pc computer".split()
)


def _content_tokens(text: str) -> set[str]:
    """Lowercase alphanumeric tokens, minus stopwords — for lexical overlap."""
    return {t for t in _WORD_RE.findall(text.lower()) if t not in _STOP and len(t) > 1}

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
    onnx_path = _find("model.onnx")
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
        # Mean-pool over the real (unmasked) tokens — the e5 convention.
        mask = np.asarray(enc.attention_mask, dtype=np.float32)[:, None]
        vecs[row] = (last_hidden[0] * mask).sum(axis=0) / max(float(mask.sum()), 1e-9)
    norms = np.linalg.norm(vecs, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return vecs / norms  # L2-normalized → dot product == cosine similarity


@asynccontextmanager
async def lifespan(app: FastAPI):
    _load()
    yield


app = FastAPI(title="ITLedger AI", version="0.4.0", lifespan=lifespan)
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
        _state["corpus_vecs"] = _embed([DOC_PREFIX + t for t in texts])
        _state["corpus_ids"] = ids
        _state["corpus_hash"] = digest

    qvec = _embed([QUERY_PREFIX + req.query])[0]
    sims = _state["corpus_vecs"] @ qvec  # semantic cosine, ~[-1, 1]

    # Lexical signal: fraction of the query's content words present in each doc.
    qtok = _content_tokens(req.query)
    if qtok and LEX_WEIGHT:
        lex = np.array(
            [len(qtok & _content_tokens(t)) / len(qtok) for t in texts],
            dtype=np.float32,
        )
    else:
        lex = np.zeros(len(texts), dtype=np.float32)

    # Rank by the hybrid score, but report the pure semantic cosine as `score`
    # so the relevance % stays an honest "how close in meaning" (0–1).
    hybrid = sims + LEX_WEIGHT * lex
    order = np.argsort(-hybrid)[: max(1, req.top_k)]
    return [
        RankResult(id=_state["corpus_ids"][i], score=float(min(1.0, max(0.0, sims[i]))))
        for i in order
    ]
