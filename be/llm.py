"""Thin OpenAI-compatible LLM client for the internal-network model.

MOSTLY DORMANT. The model server this talks to — the D:\\LLM stack on this host —
was retired, so `settings.ai_enabled` is off and the callers are guarded: the Ask
AI router is not mounted, `rerank_results` returns its input untouched, and the
import reader never reaches `read_handover_minutes`. Nothing here was deleted,
because the guards are one flag and the stack could come back; but nothing here
runs today either. Check `settings.ai_enabled` before adding a new caller.

Talks to `settings.llm_base_url` (e.g. http://192.168.3.252:8443/v1) using the
Chat Completions API with a Bearer key from be/.env. This is the ONLY place that
calls the LLM; routers use the helpers here.

PROJECT-LOCAL LEARNING: the shared model is never fine-tuned. "Learning" happens
purely by feeding this project's marked-correct rows (search_feedback) back as
few-shot examples in the rerank/explain prompts — see `rerank(..., examples=...)`.
Nothing here writes back to or trains the shared model.
"""
import json
import time
from collections.abc import AsyncIterator
from typing import NamedTuple

import httpx
from fastapi import HTTPException

from .config import settings


def _headers() -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if settings.llm_api_key:
        headers["Authorization"] = f"Bearer {settings.llm_api_key}"
    return headers


async def _chat(
    system: str,
    user: str,
    *,
    want_json: bool = False,
    temperature: float = 0.2,
    timeout: float = 120,
) -> str:
    """One chat completion. Returns the assistant message text."""
    body: dict = {
        "model": settings.llm_model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": temperature,
        "stream": False,
    }
    if want_json:
        # Supported by most OpenAI-compatible servers; harmless if ignored.
        body["response_format"] = {"type": "json_object"}

    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            f"{settings.llm_base_url}/chat/completions", json=body, headers=_headers()
        )
        resp.raise_for_status()
        data = resp.json()
    return data["choices"][0]["message"]["content"]


async def _chat_stream(
    system: str,
    user: str,
    *,
    want_json: bool = False,
    temperature: float = 0.2,
    timeout: float = 180,
) -> AsyncIterator[str]:
    """The same completion, yielded piece by piece as the model writes it.

    Streaming exists here for the PROGRESS, not the tokens: the caller cannot
    otherwise tell "the model is still loading" from "the model is answering", and
    those are 44 seconds and 6 seconds of the same silence on this hardware. The
    first yielded piece is the moment the weights are resident and generation has
    started.
    """
    body: dict = {
        "model": settings.llm_model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": temperature,
        "stream": True,
    }
    if want_json:
        body["response_format"] = {"type": "json_object"}

    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream(
            "POST", f"{settings.llm_base_url}/chat/completions",
            json=body, headers=_headers(),
        ) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line.startswith("data: "):
                    continue
                payload = line[6:].strip()
                if payload == "[DONE]":
                    break
                try:
                    delta = json.loads(payload)["choices"][0].get("delta") or {}
                except (json.JSONDecodeError, KeyError, IndexError):
                    continue  # a keepalive or a shape we don't know — not fatal
                piece = delta.get("content")
                if piece:
                    yield piece


async def warm() -> bool:
    """Make the model resident, so the next real request doesn't pay for it.

    Ollama unloads after `OLLAMA_KEEP_ALIVE` (10m on the deployment host), and
    loading llama3.1:8b costs **~44 seconds** — measured as time-to-first-token on
    a record that then generates in six. Any import made more than ten minutes
    after the last one paid that in full, before a single field was read.

    So the importer fires this the moment its dialog opens, and by the time a human
    has picked a file the weights are usually in VRAM. One token is requested
    because loading is the point and generating is not. Never raises: a failed
    warm-up is a slow import, not a broken one.
    """
    body = {
        "model": settings.llm_model,
        "messages": [{"role": "user", "content": "hi"}],
        "max_tokens": 1,
        "temperature": 0.0,
        "stream": False,
    }
    try:
        async with httpx.AsyncClient(timeout=180) as client:
            resp = await client.post(
                f"{settings.llm_base_url}/chat/completions",
                json=body, headers=_headers(),
            )
            return resp.is_success
    except httpx.HTTPError:
        return False


async def chat(system: str, user: str, *, temperature: float = 0.3, timeout: float = 240) -> str:
    """Grounded assistant answer (raises HTTPException(503) if the LLM is down)."""
    try:
        return (await _chat(system, user, temperature=temperature, timeout=timeout)).strip()
    except httpx.HTTPError as e:  # noqa: BLE001
        raise HTTPException(503, f"LLM unavailable: {e}")


class AgentResult(NamedTuple):
    answer: str
    tool_calls: list[str]
    elapsed_ms: int


async def chat_agent(
    system: str,
    messages: list[dict],
    tools: list[dict],
    dispatch,
    *,
    max_steps: int = 6,
    temperature: float = 0.2,
    timeout: float = 240,
) -> AgentResult:
    """Agentic chat. The model may call `tools` — each executed via
    `await dispatch(name, args)` which returns a text result — across up to
    `max_steps` rounds, then returns its final answer plus which tools were
    called (in order) and the total elapsed time, for a UI trace.

    `messages` is the prior conversation (already role-mapped, no system message).
    Grounding baseline lives in `system`, so this degrades gracefully: if the
    server ignores tool-calling (returns content on the first turn) we still get a
    grounded answer, and if it rejects the `tools` param outright (HTTP 400) we
    retry toolless. Raises HTTPException(503) only when the LLM is unreachable."""
    start = time.monotonic()
    called: list[str] = []
    convo: list[dict] = [{"role": "system", "content": system}, *messages]
    headers = {"Content-Type": "application/json"}
    if settings.llm_api_key:
        headers["Authorization"] = f"Bearer {settings.llm_api_key}"
    url = f"{settings.llm_base_url}/chat/completions"
    use_tools = True

    def _result(answer: str) -> AgentResult:
        return AgentResult(answer, called, int((time.monotonic() - start) * 1000))

    async with httpx.AsyncClient(timeout=timeout) as client:
        for _ in range(max_steps):
            body: dict = {
                "model": settings.llm_model,
                "messages": convo,
                "temperature": temperature,
                "stream": False,
            }
            if use_tools:
                body["tools"] = tools
                body["tool_choice"] = "auto"
            try:
                resp = await client.post(url, json=body, headers=headers)
                if use_tools and resp.status_code == 400:
                    use_tools = False  # server can't do tool-calling — stay grounded, drop tools
                    continue
                resp.raise_for_status()
                msg = resp.json()["choices"][0]["message"]
            except httpx.HTTPError as e:  # noqa: BLE001
                raise HTTPException(503, f"LLM unavailable: {e}")

            requested_calls = (msg.get("tool_calls") or []) if use_tools else []
            if not requested_calls:
                return _result((msg.get("content") or "").strip())

            convo.append(msg)  # the assistant turn that requested the tool calls
            for call in requested_calls:
                fn = call.get("function", {})
                called.append(fn.get("name", ""))
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except json.JSONDecodeError:
                    args = {}
                try:
                    result = await dispatch(fn.get("name", ""), args)
                except Exception as e:  # noqa: BLE001 — a tool failure is data for the model
                    result = f"error: {e}"
                convo.append({
                    "role": "tool",
                    "tool_call_id": call.get("id"),
                    "content": result if isinstance(result, str)
                    else json.dumps(result, default=str),
                })

        # Steps exhausted: one final toolless pass to force a summary answer.
        convo.append({
            "role": "user",
            "content": "Answer now using the information already gathered above. "
            "Do not request any more tools.",
        })
        try:
            resp = await client.post(
                url,
                json={
                    "model": settings.llm_model,
                    "messages": convo,
                    "temperature": temperature,
                    "stream": False,
                },
                headers=headers,
            )
            resp.raise_for_status()
            return _result((resp.json()["choices"][0]["message"].get("content") or "").strip())
        except httpx.HTTPError as e:  # noqa: BLE001
            raise HTTPException(503, f"LLM unavailable: {e}")


async def explain(query: str, document: str) -> str:
    """One-sentence, grounded 'why this record matched the search'."""
    system = (
        "You explain, in ONE short sentence (max 24 words), why an inventory record "
        "matches a search query. Cite the record's own facts. No preamble, no "
        "markdown, just the sentence."
    )
    user = f'Search query: "{query}"\nRecord: {document}\n\nWhy does it match?'
    try:
        return (await _chat(system, user, temperature=0.2, timeout=90)).strip()
    except httpx.HTTPError as e:  # noqa: BLE001
        raise HTTPException(503, f"LLM explain unavailable: {e}")


HANDOVER_READER_SYSTEM = """\
You read ONE Vietnamese/English IT handover record ("BIÊN BẢN BÀN GIAO / HANDOVER
MINUTES") that has been flattened to text, and return it as JSON.

The record is a FORM, not a table. Labels sit in one cell and their value in a
cell to the right, e.g. `B10 "Trịnh Thế Hưng"` is the value of `A10 "Bên A/ Party A:"`.
Labels you will meet: `Địa điểm/ Place`, `Bên A/ Party A`, `Bên B/ Party B`,
`Bên C/ Party C` and further letters, `Mã NV/ Code`, `Bộ phận/ Dept.`,
`Chức vụ/ Position`. Below `Nội dung bàn giao/ Contents` there IS a small table
whose header row contains `SERIAL`; every row under it with a number in the `No.`
column is one handed-over item.

Return EXACTLY this shape:
{"handover_date":"YYYY-MM-DD","place":"...",
 "parties":[{"label":"A","name":"","code":"","dept":"","position":""}],
 "items":[{"no":1,"item":"","quantity":1,"detail":"","serial":"","note":"",
           "device":{"type":"","brand":"","cpu":"","ram":"","storage":"","name":""}}]}

Rules:
- COPY values verbatim from the text. Never invent, translate, correct spelling,
  or fill a blank with something plausible. Use null for anything not present.
- `parties`: ONE object per `Bên …/ Party …` row that is actually in the text, in
  the order they appear, with `label` set to that row's own letter. Two is the
  usual number; three or more is normal and every one of them must be returned.
  Never stop at B, and never add a party the text does not have.
- `handover_date`: use the ISO date in square brackets after a date cell if there
  is one (e.g. `D5 "Tuesday, July 21, 2026" [2026-07-21]` → "2026-07-21").
- One object per `No.` row — no more, no fewer. A record with a single item is
  normal and complete; do not invent a second row.
- `device` splits the `Chi tiết/ Detail` text into parts, each part still a
  substring of the text: "HP Laptop core i3 ram 8gb SSD 256gb" → type "Laptop",
  brand "HP", cpu "core i3", ram "8gb", storage "SSD 256gb". Omit what isn't there.
- Do NOT decide who gave and who received, and do NOT output any direction,
  from/to, or flow field. Bên A is not necessarily the giver. That is decided
  elsewhere from the ledger's own history.
- Output only the JSON object. No prose, no markdown fence."""


async def read_handover_minutes(sheet_text: str) -> dict:
    """Read one flattened handover record into structured fields.

    Returns {} on any failure (unreachable model, non-JSON reply) — the caller
    turns that into a clear 503, because unlike rerank there is no useful
    fallback: if the file can't be read there is nothing to import.

    The result is NOT trusted: every string it returns is checked back against
    the source text by the caller (routers/imports._verify_against_source) before
    anything reaches the database.
    """
    if not (sheet_text or "").strip():
        return {}
    try:
        raw = await _chat(
            HANDOVER_READER_SYSTEM,
            f"Handover record:\n{sheet_text}",
            want_json=True,
            temperature=0.0,
            timeout=180,
        )
        parsed = json.loads(raw)
    except (httpx.HTTPError, json.JSONDecodeError, KeyError, TypeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


# Phases a streamed read passes through, in order. Named here because the reader is
# the only thing that knows what its own silence means.
LOADING = "loading"   # request accepted, not one token back yet — weights loading
READING = "reading"   # tokens arriving; `items` counts the rows finished so far
DONE = "done"         # `parsed` carries the reading ({} if it could not be read)


async def read_handover_minutes_stream(sheet_text: str) -> AsyncIterator[dict]:
    """`read_handover_minutes`, reporting where it has got to.

    Yields `{"phase": LOADING}`, then a `{"phase": READING, "items": n}` per item
    finished, then exactly one `{"phase": DONE, "parsed": …}`. `parsed` is `{}` on
    any failure, same as the non-streaming reader — the caller turns that into a
    503, because a record that cannot be read has nothing to import.

    Progress is counted by the `"serial"` keys the model has emitted, because that
    is the one key every item carries and the count only ever goes up. The total to
    divide by is NOT guessed here: `handover_sheet.count_item_rows` reads it off the
    file's own table before any of this starts.
    """
    if not (sheet_text or "").strip():
        yield {"phase": DONE, "parsed": {}}
        return

    yield {"phase": LOADING}
    chunks: list[str] = []
    items = 0
    try:
        async for piece in _chat_stream(
            HANDOVER_READER_SYSTEM,
            f"Handover record:\n{sheet_text}",
            want_json=True,
            temperature=0.0,
            timeout=180,
        ):
            chunks.append(piece)
            # Counted over the join, not the piece: `"serial"` arrives split across
            # chunk boundaries as often as not.
            seen = "".join(chunks).count('"serial"')
            if seen > items:
                items = seen
                yield {"phase": READING, "items": items}
    except httpx.HTTPError:
        yield {"phase": DONE, "parsed": {}}
        return

    try:
        parsed = json.loads("".join(chunks))
    except (json.JSONDecodeError, TypeError):
        parsed = None
    yield {"phase": DONE, "parsed": parsed if isinstance(parsed, dict) else {}}


async def rerank(
    query: str,
    candidates: list[dict],
    examples: list[dict],
    top_k: int,
) -> list[dict]:
    """LLM re-sort of the semantic top-K, seeded with the user's marked-correct
    examples as few-shot anchors (this is how it 'learns' from feedback, per
    project, without touching the shared model). Returns [{id, reason}]; on any
    failure returns [] so the caller keeps the semantic order — search never
    hard-fails on the LLM."""
    if not candidates:
        return []
    shots = ""
    if examples:
        lines = "\n".join(
            f'- for query "{e["query"]}", CORRECT match: {e["document"]}'
            for e in examples
            if e.get("document")
        )
        if lines:
            shots = (
                "\nThe user previously marked these as correct matches — learn what "
                f"they consider relevant:\n{lines}\n"
            )
    cand = "\n".join(f'- id={c["id"]}: {c["text"]}' for c in candidates)
    system = (
        "You rank inventory search results by relevance to the query. Consider "
        "meaning, specs, history, age and owner. "
        'Respond ONLY as JSON: {"ranking":[{"id":"<id>","reason":"<short why>"}]} '
        "with every candidate id, best match first."
    )
    user = f'Query: "{query}"{shots}\nCandidates:\n{cand}'
    try:
        raw = await _chat(system, user, want_json=True, temperature=0.0, timeout=180)
        ranking = json.loads(raw).get("ranking", [])
    except (httpx.HTTPError, json.JSONDecodeError, KeyError, TypeError):
        return []
    valid = {c["id"] for c in candidates}
    order = [r for r in ranking if r.get("id") in valid]
    seen = {r["id"] for r in order}
    for c in candidates:  # any the model dropped keep their semantic order
        if c["id"] not in seen:
            order.append({"id": c["id"], "reason": ""})
    return order[: max(1, top_k)]


async def rerank_results(
    query: str, results: list[dict], examples: list[dict], id_key: str
) -> list[dict]:
    """Reorder already-ranked `results` (row dicts, each with a `document`) using
    the LLM, attaching a one-line `reason`. `id_key` is the row's id field
    (serial_number / maintenance_id / handover_id). Falls back to the input order
    if the LLM can't rerank, so search never hard-fails — and with
    `settings.ai_enabled` off, that fallback is the only path: returning the
    embedder's order at once beats burning a 180s timeout to arrive at the same
    answer."""
    if not results or not settings.ai_enabled:
        return results
    candidates = [{"id": r[id_key], "text": r.get("document", "")} for r in results]
    order = await rerank(query, candidates, examples, top_k=len(results))
    if not order:
        return results
    by_id = {r[id_key]: r for r in results}
    reordered: list[dict] = []
    for o in order:
        r = by_id.get(o.get("id"))
        if r:
            reordered.append({**r, "reason": o.get("reason") or None})
    seen = {r[id_key] for r in reordered}
    reordered.extend(r for r in results if r[id_key] not in seen)
    return reordered
