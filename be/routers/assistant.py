"""LLM assistant — grounded Q&A over the device inventory (RAG).

Thin HTTP layer: flatten the fleet into a compact context, hand it plus the
question to the local LLM (via the ai service, which proxies Ollama), return the
answer. No SQL here beyond the repo reads.
"""
import os
from collections import Counter

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..config import settings
from ..db import get_pool
from ..repositories import device as device_repo
from ..repositories import maintenance as maint_repo
from ..repositories import user as user_repo

router = APIRouter(prefix="/assistant", tags=["assistant"])

# The counts/aggregations are done HERE (exact, ~0 CPU) and handed to the LLM as
# a compact stats block, so the model never "counts" over raw rows — that's what
# was pegging the CPU. A short device sample follows for name-level lookups.
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
    """A compact one-row summary of a device for the LLM context (token-frugal
    vs. the full search document)."""
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

    try:
        async with httpx.AsyncClient(timeout=240) as client:
            resp = await client.post(
                f"{settings.ai_url}/chat",
                json={"question": req.question, "context": context},
            )
            resp.raise_for_status()
            return resp.json()
    except httpx.HTTPError as e:
        raise HTTPException(503, f"LLM assistant unavailable: {e}")
