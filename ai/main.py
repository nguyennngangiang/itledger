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
import json
import os
import re
from contextlib import asynccontextmanager
from urllib import request as urlrequest

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
# Hybrid ranking: final = semantic_cosine + LEX_WEIGHT * (query-word overlap).
# The embedder captures meaning but is weak on exact/rare tokens (a serial, a
# brand, "i7"); a light lexical boost floats literal hits up without letting
# keywords dominate meaning. 0 disables it (pure semantic).
LEX_WEIGHT = float(os.getenv("LEX_WEIGHT", "0.18"))
_WORD_RE = re.compile(r"[a-z0-9]+")
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


# ----------------------------------------------------------------------------
# Local generative LLM (Ollama) — rerank / explain / ask.
#
# Ollama runs on this same host at :11434. We proxy it here so the whole "AI"
# surface lives in one service and the Dockerized backend only ever talks to
# this one at :8001 (it can't reach the host's Ollama directly). Endpoints are
# sync `def` so FastAPI runs them in a threadpool — the model call is blocking.
# ----------------------------------------------------------------------------
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434").rstrip("/")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen2.5:7b")
# Leave some logical cores free so CPU inference doesn't peg every core and
# starve the browser / UI. Default: all but 4.
OLLAMA_NUM_THREAD = int(
    os.getenv("OLLAMA_NUM_THREAD", str(max(4, (os.cpu_count() or 8) - 4)))
)


def _ollama_chat(system: str, user: str, *, want_json=False, temperature=0.2,
                 timeout=180) -> str:
    body = {
        "model": OLLAMA_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "stream": False,
        "options": {"temperature": temperature, "num_thread": OLLAMA_NUM_THREAD},
    }
    if want_json:
        body["format"] = "json"
    req = urlrequest.Request(
        f"{OLLAMA_URL}/api/chat",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urlrequest.urlopen(req, timeout=timeout) as resp:
        payload = json.loads(resp.read())
    return payload["message"]["content"]


@app.get("/llm/health")
def llm_health():
    """Is the local LLM reachable and is the configured model pulled?"""
    try:
        with urlrequest.urlopen(f"{OLLAMA_URL}/api/tags", timeout=5) as resp:
            models = [m["name"] for m in json.loads(resp.read()).get("models", [])]
        base = OLLAMA_MODEL.split(":")[0]
        ready = any(m == OLLAMA_MODEL or m.startswith(base) for m in models)
        return {"ready": ready, "model": OLLAMA_MODEL, "available": models}
    except Exception as e:  # noqa: BLE001 — report, don't crash health
        return {"ready": False, "model": OLLAMA_MODEL, "error": str(e)}


class ExplainRequest(BaseModel):
    query: str
    document: str


@app.post("/explain")
def explain(req: ExplainRequest):
    """One-sentence, grounded 'why this device matched the search'."""
    system = (
        "You explain, in ONE short sentence (max 24 words), why an IT device "
        "matches a search query. Cite the device's own facts (specs, repairs, "
        "age, owner). No preamble, no markdown, just the sentence."
    )
    user = f'Search query: "{req.query}"\nDevice: {req.document}\n\nWhy does it match?'
    try:
        text = _ollama_chat(system, user, temperature=0.2, timeout=90)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"LLM unavailable: {e}")
    return {"explanation": text.strip()}


class RerankCandidate(BaseModel):
    id: str
    text: str


class RerankExample(BaseModel):
    query: str
    document: str


class RerankRequest(BaseModel):
    query: str
    candidates: list[RerankCandidate]
    examples: list[RerankExample] = []
    top_k: int = 12


@app.post("/rerank")
def rerank(req: RerankRequest):
    """LLM re-sort of the semantic top-K, seeded with the user's marked-correct
    examples as few-shot anchors (this is how it 'learns' from feedback)."""
    if not req.candidates:
        return {"order": []}
    shots = ""
    if req.examples:
        lines = "\n".join(
            f'- for query "{e.query}", CORRECT match: {e.document}'
            for e in req.examples
        )
        shots = (
            "\nThe user previously marked these as correct matches — learn what "
            f"they consider relevant:\n{lines}\n"
        )
    cand = "\n".join(f"- id={c.id}: {c.text}" for c in req.candidates)
    system = (
        "You rank IT-device search results by relevance to the query. "
        "Consider meaning, specs, repair history, age and owner. "
        'Respond ONLY as JSON: {"ranking":[{"id":"<id>","reason":"<short why>"}]} '
        "with every candidate id, best match first."
    )
    user = f'Query: "{req.query}"{shots}\nCandidates:\n{cand}'
    try:
        raw = _ollama_chat(system, user, want_json=True, temperature=0.0, timeout=180)
        ranking = json.loads(raw).get("ranking", [])
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"LLM rerank failed: {e}")
    valid = {c.id for c in req.candidates}
    order = [r for r in ranking if r.get("id") in valid]
    seen = {r["id"] for r in order}
    for c in req.candidates:  # any the model dropped keep their semantic order
        if c.id not in seen:
            order.append({"id": c.id, "reason": ""})
    return {"order": order[: req.top_k]}


class ChatRequest(BaseModel):
    question: str
    context: str


@app.post("/chat")
def chat(req: ChatRequest):
    """Grounded Q&A over the device inventory (RAG — context passed in)."""
    system = (
        "You are the IT Ledger assistant. Answer ONLY from the device inventory "
        "context provided. For any count or total, use the exact numbers in "
        "FLEET STATS verbatim — never tally the device rows yourself. Use the "
        "DEVICE SAMPLE only for name-level detail. If the answer isn't in the "
        "context, say you don't have that data. Be concise; prefer bullet points."
    )
    user = f"Device inventory:\n{req.context}\n\nQuestion: {req.question}"
    try:
        text = _ollama_chat(system, user, temperature=0.3, timeout=240)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"LLM unavailable: {e}")
    return {"answer": text.strip()}
