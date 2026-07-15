"""LLM assistant — grounded, cross-resource Q&A over the fleet (agentic RAG).

The model gets an exact FLEET STATS block up front (so counts are never tallied
by the LLM) plus a set of TOOLS it can call to pull the detail it needs — device
specs, a single machine's full repair + handover history (the cross-resource
JOIN), or a semantic/bilingual search over any one resource. It combines those to
answer questions that span devices, maintenance and handovers. Multi-turn: the
frontend sends recent chat history so follow-ups ("what about its handovers?")
resolve. See be/llm.chat_agent for the tool loop; grounding baseline in `system`
means it still answers (from stats) if the model can't tool-call.
"""
import asyncio
import base64
import binascii
import json
import os
from collections import Counter
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..db import get_pool
from .. import llm
from .. import extract
from ..documents import device_document, handover_document, maintenance_document
from ..search import rank
from ..repositories import device as device_repo
from ..repositories import handover as handover_repo
from ..repositories import maintenance as maint_repo
from ..repositories import user as user_repo

router = APIRouter(prefix="/assistant", tags=["assistant"])

# How many recent chat turns the frontend history is trimmed to (keeps tokens sane).
MAX_HISTORY = int(os.getenv("ASSISTANT_HISTORY", "8"))


def _fleet_stats(devices: list[dict], counts: dict[str, int], users: dict) -> str:
    """Exact, precomputed fleet aggregates — the deterministic answer to every
    'how many …' question, so the LLM reads numbers instead of tallying rows."""
    by_status: Counter = Counter()
    by_type: Counter = Counter()
    by_brand: Counter = Counter()
    by_team: Counter = Counter()
    laptops_by_team: Counter = Counter()
    repaired: list[tuple[str, int]] = []
    ages: list[tuple[str, int]] = []
    unassigned = 0

    for d in devices:
        name = d.get("name") or d["serial_number"]
        by_status[d.get("status") or "unknown"] += 1
        typ = (d.get("type") or "unknown").upper()
        by_type[typ] += 1
        by_brand[d.get("brand") or "unknown"] += 1
        team = (users.get(d.get("user_id")) or {}).get("team")
        if team:
            by_team[team] += 1
            if "LAPTOP" in typ:
                laptops_by_team[team] += 1
        else:
            unassigned += 1
        n = counts.get(d["serial_number"], 0)
        if n:
            repaired.append((name, n))
        if d.get("buy_date"):
            ages.append((name, d["buy_date"].year))

    def fmt(c: Counter, top: int | None = None) -> str:
        return ", ".join(f"{k} {v}" for k, v in c.most_common(top)) or "none"

    top_repaired = sorted(repaired, key=lambda x: -x[1])[:5]
    oldest = sorted(ages, key=lambda x: x[1])[:5]
    return "\n".join(
        [
            "FLEET STATS (exact, precomputed — use these numbers directly, never recount):",
            f"Total devices: {len(devices)}",
            f"By status: {fmt(by_status)}",
            f"By type: {fmt(by_type)}",
            f"By brand (top 10): {fmt(by_brand, 10)}",
            f"Devices per team: {fmt(by_team)}",
            f"Laptops per team: {fmt(laptops_by_team)}",
            f"Unassigned / in stock (no owner): {unassigned}",
            "Most-repaired: "
            + (", ".join(f"{n} ({c}x)" for n, c in top_repaired) or "none"),
            "Oldest by purchase year: "
            + (", ".join(f"{n} ({y})" for n, y in oldest) or "unknown"),
        ]
    )


# --- tools ------------------------------------------------------------------
# OpenAI-style function schemas the model may call. Kept small and orthogonal:
# filter devices, pull one machine's full cross-resource history, or fuzzy-search
# any one resource (documents are bilingual so Vietnamese queries match).
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "find_devices",
            "description": (
                "List devices matching structured filters (owner team, type, brand, "
                "status, owner person, or a name/serial substring). Use for "
                "'which/how many devices are …' questions. Returns compact device "
                "rows including owner team and repair count."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "team": {"type": "string", "description": "Owner's team, e.g. 'DEV'"},
                    "type": {"type": "string", "description": "Device type, e.g. 'laptop'"},
                    "brand": {"type": "string"},
                    "status": {"type": "string", "description": "e.g. 'active', 'maintaining'"},
                    "owner": {"type": "string", "description": "Owner name or employee code"},
                    "name_contains": {"type": "string", "description": "Substring of device name or serial"},
                    "limit": {"type": "integer", "description": "Max rows (default 25)"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "device_history",
            "description": (
                "Full record for ONE device by serial number or name: its specs and "
                "owner, its complete maintenance history (reasons, solutions, cost) "
                "AND its complete handover history (who gave/received it, when, why). "
                "Use this for any question about a specific machine's repairs and/or "
                "handovers — it joins all three tables."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "device": {"type": "string", "description": "Serial number or device name"},
                },
                "required": ["device"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "semantic_search",
            "description": (
                "Fuzzy natural-language search over ONE resource when you don't have "
                "an exact name/filter — matches meaning, specs, symptoms, history "
                "(works for Vietnamese queries too). Returns the top matching records "
                "as descriptive sentences with a relevance score."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "resource": {
                        "type": "string",
                        "enum": ["devices", "maintenance", "handovers"],
                    },
                    "query": {"type": "string", "description": "Natural-language search text"},
                    "limit": {"type": "integer", "description": "Max results (default 15)"},
                },
                "required": ["resource", "query"],
            },
        },
    },
]


async def _users_map(pool) -> dict:
    return {u["employee_code"]: u for u in await user_repo.list_users(pool)}


def _owner_str(user: dict | None) -> str:
    if not user:
        return "unassigned / in stock"
    name = user.get("name") or user.get("employee_code")
    team = user.get("team")
    return f"{name} ({team})" if team else name


async def _find_devices(pool, args: dict) -> str:
    devices = await device_repo.list_devices(pool)
    users = await _users_map(pool)
    counts = await maint_repo.counts_by_device(pool)

    def matches(d: dict) -> bool:
        owner = users.get(d.get("user_id")) or {}
        team = (owner.get("team") or "")
        if (t := args.get("team")) and t.lower() not in team.lower():
            return False
        if (ty := args.get("type")) and ty.lower() not in (d.get("type") or "").lower():
            return False
        if (b := args.get("brand")) and b.lower() not in (d.get("brand") or "").lower():
            return False
        if (s := args.get("status")) and s.lower() not in (d.get("status") or "").lower():
            return False
        if (o := args.get("owner")):
            hay = f"{owner.get('name', '')} {d.get('user_id') or ''}".lower()
            if o.lower() not in hay:
                return False
        if (nc := args.get("name_contains")):
            hay = f"{d.get('name') or ''} {d['serial_number']}".lower()
            if nc.lower() not in hay:
                return False
        return True

    limit = int(args.get("limit") or 25)
    rows = [
        {
            "serial_number": d["serial_number"],
            "name": d.get("name"),
            "type": d.get("type"),
            "brand": d.get("brand"),
            "cpu": d.get("cpu"),
            "ram": d.get("ram"),
            "storage": d.get("storage"),
            "os": d.get("os"),
            "status": d.get("status"),
            "owner": _owner_str(users.get(d.get("user_id"))),
            "repairs": counts.get(d["serial_number"], 0),
        }
        for d in devices
        if matches(d)
    ][:limit]
    return json.dumps({"count": len(rows), "devices": rows}, default=str, ensure_ascii=False)


async def _device_history(pool, args: dict) -> str:
    key = (args.get("device") or "").strip()
    if not key:
        return json.dumps({"error": "no device given"})
    device = await device_repo.get(pool, key)
    if device is None:
        hits = await device_repo.search(pool, key)
        if not hits:
            return json.dumps({"error": f"no device matching '{key}'"})
        if len(hits) > 1:
            return json.dumps({
                "ambiguous": f"multiple devices match '{key}' — ask to pick one",
                "candidates": [
                    {"serial_number": h["serial_number"], "name": h.get("name")} for h in hits[:10]
                ],
            }, default=str, ensure_ascii=False)
        device = hits[0]

    serial = device["serial_number"]
    users = await _users_map(pool)
    maints = await maint_repo.list_maintenance(pool, device_id=serial)
    handovers = await handover_repo.list_handovers(pool, device_id=serial)

    payload = {
        "device": {
            "serial_number": serial,
            "name": device.get("name"),
            "type": device.get("type"),
            "brand": device.get("brand"),
            "cpu": device.get("cpu"),
            "ram": device.get("ram"),
            "storage": device.get("storage"),
            "os": device.get("os"),
            "msoffice": device.get("msoffice"),
            "status": device.get("status"),
            "buy_date": device.get("buy_date"),
            "owner": _owner_str(users.get(device.get("user_id"))),
        },
        "repair_count": len(maints),
        "maintenance": [
            {
                "date": m.get("maintenance_date"),
                "part": m.get("part"),
                "problem": m.get("reason"),
                "solution": m.get("solution"),
                "result": m.get("result"),
                "cost_vnd": m.get("cost_vnd"),
                "team": m.get("team"),
                "remarks": m.get("remarks"),
            }
            for m in maints
        ],
        "handovers": [
            {
                "date": h.get("handover_date"),
                "from": _owner_str(users.get(h.get("from_user_id"))),
                "to": _owner_str(users.get(h.get("to_user_id"))),
                "reason": h.get("reason"),
            }
            for h in handovers
        ],
    }
    return json.dumps(payload, default=str, ensure_ascii=False)


async def _semantic_search(pool, args: dict) -> str:
    resource = args.get("resource")
    query = (args.get("query") or "").strip()
    limit = int(args.get("limit") or 15)
    if not query:
        return json.dumps({"error": "no query"})

    users = await _users_map(pool)
    if resource == "devices":
        devices = await device_repo.list_devices(pool)
        counts = await maint_repo.counts_by_device(pool)
        docs = [
            {
                "id": d["serial_number"],
                "text": device_document(
                    d, counts.get(d["serial_number"], 0),
                    (users.get(d.get("user_id")) or {}).get("team"),
                ),
            }
            for d in devices
        ]
    elif resource == "maintenance":
        records = await maint_repo.list_maintenance(pool)
        devices = {d["serial_number"]: d for d in await device_repo.list_devices(pool)}
        docs = [
            {"id": m["maintenance_id"], "text": maintenance_document(m, devices, users)}
            for m in records
        ]
    elif resource == "handovers":
        records = await handover_repo.list_handovers(pool)
        devices = {d["serial_number"]: d for d in await device_repo.list_devices(pool)}
        docs = [
            {"id": h["handover_id"], "text": handover_document(h, devices, users)}
            for h in records
        ]
    else:
        return json.dumps({"error": f"unknown resource '{resource}'"})

    if not docs:
        return json.dumps({"results": []})
    text_by_id = {d["id"]: d["text"] for d in docs}
    ranked = await rank(query, docs, limit)
    results = [
        {"id": r["id"], "score": round(r["score"], 4), "text": text_by_id.get(r["id"], "")}
        for r in ranked
        if r["id"] in text_by_id
    ]
    return json.dumps({"results": results}, default=str, ensure_ascii=False)


def _dispatch(pool):
    handlers = {
        "find_devices": _find_devices,
        "device_history": _device_history,
        "semantic_search": _semantic_search,
    }

    async def run(name: str, args: dict) -> str:
        handler = handlers.get(name)
        if handler is None:
            return json.dumps({"error": f"unknown tool '{name}'"})
        return await handler(pool, args)

    return run


class ChatMsg(BaseModel):
    role: Literal["user", "ai"]
    text: str


class Attachment(BaseModel):
    name: str
    mime: str = ""
    data: str  # base64-encoded file bytes


class AskRequest(BaseModel):
    question: str
    history: list[ChatMsg] | None = None
    attachments: list[Attachment] | None = None


class AskResult(BaseModel):
    answer: str
    tool_calls: list[str] = []
    elapsed_ms: int = 0


# Cap the total extracted-file text folded into the prompt (protect the context).
MAX_ATTACHMENT_CHARS = int(os.getenv("ASSISTANT_ATTACHMENT_CHARS", "30000"))


# Plain-text formats are already text — decode locally instead of calling
# /rag/extract (which only handles xlsx/docx/pdf/images and 415s on these).
_TEXT_EXTS = {"csv", "txt", "md", "json", "log", "tsv", "yaml", "yml"}


def _is_text(att: Attachment) -> bool:
    if att.mime.startswith("text/"):
        return True
    return att.name.rsplit(".", 1)[-1].lower() in _TEXT_EXTS


async def _one_file_block(att: Attachment) -> str:
    """Turn one attachment into a labelled text block: plain-text files are decoded
    directly, everything else is extracted via /rag/extract (which OCRs images/
    scanned PDFs). A single bad file becomes a note, never a hard failure."""
    try:
        raw = base64.b64decode(att.data, validate=False)
    except (binascii.Error, ValueError):
        return f"--- File: {att.name} ---\n(không đọc được: dữ liệu base64 lỗi)"
    if _is_text(att):
        text = raw.decode("utf-8", errors="replace").strip()
        return f"--- File: {att.name} ---\n" + (text or "(file rỗng)")
    try:
        result = await extract.extract_file(att.name, att.mime, raw)
    except HTTPException as e:
        return f"--- File: {att.name} ---\n(không trích xuất được: {e.detail})"
    parts = [f"--- File: {att.name} ---"]
    text = (result.get("text") or "").strip()
    if text:
        parts.append(text)
    for t in result.get("tables") or []:
        md = (t.get("markdown") or "").strip()
        if md:
            parts.append("Table:\n" + md)
    if len(parts) == 1:
        parts.append("(không có nội dung trích xuất được)")
    return "\n".join(parts)


async def _attachments_block(attachments: list[Attachment]) -> str:
    """Extract all attachments (concurrently) into one ATTACHED FILES context block."""
    blocks = await asyncio.gather(*(_one_file_block(a) for a in attachments))
    body = "\n\n".join(blocks)
    if len(body) > MAX_ATTACHMENT_CHARS:
        body = body[:MAX_ATTACHMENT_CHARS] + "\n…(nội dung file bị cắt bớt)"
    return (
        "ATTACHED FILES (nội dung đã trích xuất — coi là dữ liệu gốc do người dùng "
        "cung cấp):\n" + body
    )


@router.post("/ask", response_model=AskResult)
async def ask(req: AskRequest, pool=Depends(get_pool)):
    devices = await device_repo.list_devices(pool)
    counts = await maint_repo.counts_by_device(pool)
    users = await _users_map(pool)
    stats = _fleet_stats(devices, counts, users)

    system = (
        "You are the IT Ledger assistant. The inventory has three linked resources: "
        "DEVICES (a machine, keyed by serial_number), MAINTENANCE (repair records "
        "linked to a device), and HANDOVERS (a device changing hands, from one "
        "person/team to another). They join on the device's serial number.\n\n"
        f"{stats}\n\n"
        "For any count or total, use the FLEET STATS numbers above verbatim — never "
        "tally rows yourself. For anything else, CALL THE TOOLS to fetch the detail: "
        "use device_history for one machine's repairs and/or handovers (it joins all "
        "three tables), find_devices to filter the fleet, and semantic_search for "
        "fuzzy or Vietnamese natural-language lookups. Combine tool results to answer "
        "questions that span devices, maintenance and handovers.\n"
        "ATTACHED FILES: if the user's message contains an ATTACHED FILES section, that "
        "is the content of files THEY uploaded — it is the primary source. Answer "
        "questions about 'the file / the attachment / this document' DIRECTLY from that "
        "section; do NOT call semantic_search to look those up (the tools only see the "
        "fleet database, not the uploaded file). Only call the tools when the user "
        "explicitly wants to cross-reference the file against the live fleet (e.g. "
        "'which of these serials are in our inventory').\n"
        "If the data doesn't contain the answer, say so. Be concise; prefer bullet "
        "points. Reply in the same language as the question (Vietnamese if the user "
        "writes Vietnamese)."
    )

    messages: list[dict] = []
    for m in (req.history or [])[-MAX_HISTORY:]:
        messages.append({
            "role": "assistant" if m.role == "ai" else "user",
            "content": m.text,
        })

    user_content = req.question
    if req.attachments:
        user_content = f"{req.question}\n\n{await _attachments_block(req.attachments)}"
    messages.append({"role": "user", "content": user_content})

    result = await llm.chat_agent(system, messages, TOOLS, _dispatch(pool))
    return {
        "answer": result.answer,
        "tool_calls": result.tool_calls,
        "elapsed_ms": result.elapsed_ms,
    }


class ExplainRequest(BaseModel):
    query: str
    document: str


class ExplainResult(BaseModel):
    explanation: str


@router.post("/explain", response_model=ExplainResult)
async def explain_match(req: ExplainRequest):
    """One-liner explaining why a record matched — powers the proof card on every
    smart-search screen (resource-agnostic; `document` is generic text)."""
    return {"explanation": await llm.explain(req.query, req.document)}
