"""Shared flatteners: turn a resource row into a short **bilingual**
natural-language sentence for embedding / LLM context.

Used by the three `/semantic-search` endpoints AND the assistant's tools, so the
same document a query is ranked on is the same text the assistant reasons over.
Kept human-readable on purpose — the device flatten doubles as the UI's "why
matched" proof text. Every result ends with `bilingualize(...)` so a Vietnamese
query matches the (English) data.
"""
from datetime import date

from .glossary import bilingualize


def _age_phrase(buy_date) -> str | None:
    """Describe the device's age so queries like 'old' / 'aging' have signal."""
    if not buy_date:
        return None
    years = (date.today() - buy_date).days / 365.25
    label = f"purchased {buy_date.year}, about {round(years)} years old"
    if years >= 5:
        label += ", aging old hardware"
    return label


def _repair_phrase(repairs: int) -> str:
    """Describe repair history in words that also match 'broken' / 'malfunction'."""
    if not repairs:
        return "never repaired, no malfunctions"
    label = f"repaired {repairs} times, has broken down and malfunctioned"
    if repairs >= 3:
        label += ", frequently breaking, unreliable"
    return label


def _status_phrase(status: str | None) -> str | None:
    if not status:
        return None
    if status == "maintaining":
        return "status maintaining, currently broken and under repair"
    return f"status {status}"


def device_document(device: dict, repairs: int, team: str | None) -> str:
    """Flatten a device into a short natural-language line for embedding.

    This is also returned to the UI as the match's *proof* — the exact text the
    embedder read — so it stays human-readable on purpose.
    """
    ram = device.get("ram")
    parts = [
        device.get("name") or device["serial_number"],
        device.get("type"),
        device.get("brand"),
        device.get("cpu"),
        f"{ram} RAM" if ram else None,
        device.get("storage"),
        device.get("os"),
        device.get("msoffice"),
        _status_phrase(device.get("status")),
        f"owned by {team} team" if team else "unassigned, in stock",
        _repair_phrase(repairs),
        _age_phrase(device.get("buy_date")),
    ]
    return bilingualize(", ".join(p for p in parts if p))


def maintenance_document(m: dict, devices: dict, users: dict) -> str:
    """Flatten a maintenance record into a short natural-language line for
    embedding — its repair story plus the device it belongs to and owner team."""
    device = devices.get(m.get("device_id")) if m.get("device_id") else None
    team = (users.get((device or {}).get("user_id")) or {}).get("team") if device else None
    date_ = m.get("maintenance_date")
    cost = m.get("cost_vnd")
    parts = [
        (device or {}).get("name") or m.get("device_id"),
        f"part {m['part']}" if m.get("part") else None,
        f"problem: {m['reason']}" if m.get("reason") else None,
        f"solution: {m['solution']}" if m.get("solution") else None,
        f"result: {m['result']}" if m.get("result") else None,
        m.get("remarks"),
        f"{team} team" if team else (f"team {m['team']}" if m.get("team") else None),
        f"cost {cost} VND" if cost else None,
        f"repaired {date_.year}" if date_ else None,
    ]
    return bilingualize(", ".join(str(p) for p in parts if p))


def _who(user: dict, uid: str | None) -> str | None:
    if not uid:
        return None
    name = user.get("name") or uid
    team = user.get("team")
    return f"{name} ({team})" if team else name


def handover_document(h: dict, devices: dict, users: dict) -> str:
    """Flatten a handover into a short natural-language line for embedding — the
    device, who gave and received it, the reason and date."""
    device = devices.get(h.get("device_id")) if h.get("device_id") else None
    date_ = h.get("handover_date")
    parts = [
        f"handover of {(device or {}).get('name') or h['device_id']}"
        if h.get("device_id")
        else "handover",
        f"from {_who(users.get(h.get('from_user_id')) or {}, h.get('from_user_id'))}"
        if h.get("from_user_id")
        else None,
        f"to {_who(users.get(h.get('to_user_id')) or {}, h.get('to_user_id'))}"
        if h.get("to_user_id")
        else None,
        f"reason: {h['reason']}" if h.get("reason") else None,
        f"on {date_}" if date_ else None,
    ]
    return bilingualize(", ".join(p for p in parts if p))
