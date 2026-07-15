"""Thin OpenAI-compatible LLM client for the internal-network model.

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
from typing import NamedTuple

import httpx
from fastapi import HTTPException

from .config import settings


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
    headers = {"Content-Type": "application/json"}
    if settings.llm_api_key:
        headers["Authorization"] = f"Bearer {settings.llm_api_key}"

    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            f"{settings.llm_base_url}/chat/completions", json=body, headers=headers
        )
        resp.raise_for_status()
        data = resp.json()
    return data["choices"][0]["message"]["content"]


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
    if the LLM can't rerank, so search never hard-fails."""
    if not results:
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
