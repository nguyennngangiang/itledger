"""LLM assistant — grounded Q&A over the device inventory (RAG) + match explain.

Thin HTTP layer: flatten the fleet into a compact context, hand it plus the
question to the internal LLM (be/llm), return the answer. Counts/aggregations are
computed HERE (exact) and handed to the LLM as a stats block, so the model never
tallies raw rows.
"""
import os
from collections import Counter

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ..db import get_pool
from .. import llm
from ..repositories import device as device_repo
from ..repositories import maintenance as maint_repo
from ..repositories import user as user_repo

router = APIRouter(prefix="/assistant", tags=["assistant"])

# A short device sample follows the exact stats block for name-level lookups.
MAX_CONTEXT_DEVICES = int(os.getenv("ASSISTANT_SAMPLE", "60"))


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


def _terse(device: dict, repairs: int, team: str | None) -> str:
    """A compact one-row summary of a device for the LLM context."""
    bits = [
        device.get("name") or device["serial_number"],
        device.get("type"),
        device.get("brand"),
        f"team {team}" if team else "unassigned",
        device.get("status"),
        f"{repairs} repairs" if repairs else None,
        f"buy {device['buy_date'].year}" if device.get("buy_date") else None,
    ]
    return " | ".join(str(b) for b in bits if b)


class AskRequest(BaseModel):
    question: str


class AskResult(BaseModel):
    answer: str


@router.post("/ask", response_model=AskResult)
async def ask(req: AskRequest, pool=Depends(get_pool)):
    devices = await device_repo.list_devices(pool)
    counts = await maint_repo.counts_by_device(pool)
    users = {u["employee_code"]: u for u in await user_repo.list_users(pool)}

    stats = _fleet_stats(devices, counts, users)
    sample = [
        _terse(
            d,
            counts.get(d["serial_number"], 0),
            (users.get(d.get("user_id")) or {}).get("team"),
        )
        for d in devices[:MAX_CONTEXT_DEVICES]
    ]
    context = (
        stats
        + "\n\nDEVICE SAMPLE (for name-level detail; not the full list):\n"
        + "\n".join(f"- {line}" for line in sample)
    )
    if len(devices) > MAX_CONTEXT_DEVICES:
        context += (
            f"\n(…{len(devices) - MAX_CONTEXT_DEVICES} more devices omitted from the "
            "sample — but the FLEET STATS above count ALL devices.)"
        )

    system = (
        "You are the IT Ledger assistant. Answer ONLY from the device inventory "
        "context provided. For any count or total, use the exact numbers in "
        "FLEET STATS verbatim — never tally the device rows yourself. Use the "
        "DEVICE SAMPLE only for name-level detail. If the answer isn't in the "
        "context, say you don't have that data. Be concise; prefer bullet points."
    )
    user = f"Device inventory:\n{context}\n\nQuestion: {req.question}"
    return {"answer": await llm.chat(system, user)}


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
