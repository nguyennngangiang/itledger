"""One-off: reconcile devices.user_id in a LIVE database with the handover log.

Two rules, both of them the IT team's own, applied to history that predates them.
The ledger was loaded from a workbook that recorded who physically signed for a
machine, not where it ended up, so:

  1. A device handed back "to IT" belongs to the STORE, not to the staffer who
     collected it. One person was standing as the owner of 29 devices while the
     team issues its members one laptop each.
  2. When a machine is collected and re-issued on the SAME DAY, the hand-out is
     the later event. Ordering those two rows by handover_id let the return win,
     so 5CD410FW9R read as "IT is holding it" while Vũ Thị Hồng Vân used it.

Why this exists instead of re-running `be.import_real`: that script TRUNCATEs all
five tables (it is a from-scratch loader) and would throw away everything entered
in the app since. This one only ever writes devices.user_id / devices.status, and
only prints what it would do unless you pass --apply.

    docker compose exec api python -m be.fix_device_owners           # dry run
    docker compose exec api python -m be.fix_device_owners --apply   # write

Rows are sorted into three groups:

  OWNER_FIXED  the device's latest event, read in the corrected order, names a
               different holder than the row currently does
  TO_STORE     the latest event handed the machine back to IT — the owner becomes
               IT-STORE and the status in_stock
  BROKEN       handover rows that cannot say anything: no recipient, or a person
               handing a device to themselves. Reported only, never guessed at —
               a human decides what those meant.
"""
import asyncio
import json
import sys
from pathlib import Path

import asyncpg

from .config import settings
from .handover_import import GHOST_CODE, store_recipient

ROOT = Path(__file__).resolve().parent.parent
# Written just before the first write, so a bad run can be undone.
BACKUP_FILE = ROOT / "devices_before_owner_fix.json"

# Every usable handover, oldest first. The same-day tie-break canNOT be done in
# SQL here the way repositories/handover does it: that ordering asks "did this row
# go to the store?", and in this legacy data a return points at the IT staffer who
# collected it, not at the store — the very thing this script is fixing. So the
# rows come back date-ordered and the tie-break happens in Python, after
# `store_recipient` has resolved where each one actually sent the machine.
USABLE_EVENTS = """
SELECT handover_id, device_id, handover_date, from_user_id, to_user_id, reason
FROM handovers
WHERE deleted_at IS NULL
  AND coalesce(btrim(to_user_id), '') <> ''
  AND coalesce(btrim(from_user_id), '') <> coalesce(btrim(to_user_id), '')
ORDER BY device_id, handover_date NULLS FIRST, handover_id
"""

BROKEN_ROWS = """
SELECT handover_id, device_id, handover_date, from_user_id, to_user_id, reason
FROM handovers
WHERE deleted_at IS NULL
  AND (coalesce(btrim(to_user_id), '') = ''
       OR coalesce(btrim(from_user_id), '') = coalesce(btrim(to_user_id), ''))
ORDER BY device_id, handover_id
"""


def status_for(owner: str) -> str:
    """Owner drives status, the same rule the app uses (lib/format.deriveStatus)."""
    return "in_stock" if owner == GHOST_CODE else "active"


def final_event(events: list[dict], device: dict, teams: dict[str, str]) -> dict:
    """The event that decides who holds the machine, with its resolved recipient.

    `events` must be one device's history, oldest first. Each row is resolved
    through `store_recipient` first, then the last day's rows are ordered
    collect-before-issue: you cannot hand out a machine you have not taken back,
    so a row landing in the store is always the earlier of the two.
    """
    resolved = [
        {
            **e,
            "goes_to": store_recipient(
                e["reason"], e["to_user_id"], {"team": teams.get(e["to_user_id"])}, device
            ),
        }
        for e in events
    ]
    last_day = max(e["handover_date"] for e in resolved)
    same_day = [e for e in resolved if e["handover_date"] == last_day]
    # Store rows key False (0) and sort first; hand-outs key True (1) and sort
    # last, so the final element is the machine leaving IT — the day's last event.
    same_day.sort(key=lambda e: (e["goes_to"] != GHOST_CODE, e["handover_id"]))
    return same_day[-1]


def classify(
    devices: dict[str, dict], events: list[dict], teams: dict[str, str]
) -> dict[str, list]:
    """Split devices into the groups above. Pure — no I/O, so it is testable."""
    by_device: dict[str, list[dict]] = {}
    for e in events:
        if e["device_id"] in devices and e["handover_date"] is not None:
            by_device.setdefault(e["device_id"], []).append(e)

    groups: dict[str, list] = {"OWNER_FIXED": [], "TO_STORE": [], "UNCHANGED": []}
    for serial, history in by_device.items():
        device = devices[serial]
        event = final_event(history, device, teams)
        should_be = event["goes_to"]

        if should_be == device["user_id"]:
            groups["UNCHANGED"].append(serial)
            continue

        groups["TO_STORE" if should_be == GHOST_CODE else "OWNER_FIXED"].append((
            serial, device["user_id"], should_be,
            event["handover_id"], event["handover_date"], event["reason"],
        ))

    for rows in groups.values():
        rows.sort(key=lambda r: r[0] if isinstance(r, tuple) else r)
    return groups


async def run(apply: bool) -> None:
    pool = await asyncpg.create_pool(dsn=settings.database_url, min_size=1, max_size=2)
    try:
        devices = {
            r["serial_number"]: dict(r)
            for r in await pool.fetch(
                "SELECT serial_number, name, cpu, user_id, status FROM devices "
                "WHERE deleted_at IS NULL"
            )
        }
        # employee_code -> team, for every user. store_recipient only needs to
        # know whether the recipient is IT, and _looks_it does that on the team.
        teams = {
            r["employee_code"]: r["team"]
            for r in await pool.fetch("SELECT employee_code, team FROM users")
        }
        events = [dict(r) for r in await pool.fetch(USABLE_EVENTS)]
        broken = [dict(r) for r in await pool.fetch(BROKEN_ROWS)]

        groups = classify(devices, events, teams)

        for key, title in (
            ("TO_STORE", "returned to IT -> IT-STORE / in_stock"),
            ("OWNER_FIXED", "latest event names a different holder"),
        ):
            rows = groups[key]
            print(f"\n== {key} ({len(rows)}) — {title} ==")
            for serial, was, now, hid, hdate, reason in rows:
                label = (devices[serial]["name"] or "")[:34]
                print(f"  {serial:<18} {label:<36} {was or '-':<9} -> {now:<9}"
                      f"  [{hid} {hdate} {reason}]")

        print(f"\n== BROKEN ({len(broken)}) — cannot say where the machine went ==")
        for b in broken:
            why = "no recipient" if not (b["to_user_id"] or "").strip() else "from == to"
            print(f"  {b['handover_id']:<10} {b['device_id']:<18} {b['handover_date']}"
                  f"  {b['from_user_id'] or '-'} -> {b['to_user_id'] or '-'}  ({why})")
        print("  ^ reported only — nobody can tell from the row what was meant.")

        print(f"\n== UNCHANGED ({len(groups['UNCHANGED'])}) ==")

        writes = groups["TO_STORE"] + groups["OWNER_FIXED"]
        if not writes:
            print("\nNothing to change.")
            return
        if not apply:
            print(f"\n{len(writes)} device(s) would change. Re-run with --apply to write.")
            return

        BACKUP_FILE.write_text(
            json.dumps(list(devices.values()), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"\nBacked up {len(devices)} device row(s) to {BACKUP_FILE.name}")

        async with pool.acquire() as conn:
            async with conn.transaction():
                for serial, _was, now, *_ in writes:
                    await conn.execute(
                        "UPDATE devices SET user_id = $1, status = $2 "
                        "WHERE serial_number = $3",
                        now, status_for(now), serial,
                    )
        print(f"Updated {len(writes)} device(s).")
    finally:
        await pool.close()


if __name__ == "__main__":
    unknown = [a for a in sys.argv[1:] if a != "--apply"]
    if unknown:
        sys.exit(f"Unknown argument(s): {' '.join(unknown)}. Only --apply is accepted.")
    asyncio.run(run("--apply" in sys.argv[1:]))
