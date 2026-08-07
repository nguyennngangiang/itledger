"""One-off: seed users.status from the HR staff list.

`employees_import.json` (extracted from employee.dump by _extract_employees.sh) is
the company's list of current staff. Anyone in the ledger that HR has no record of
has, in almost every case, left — so this marks them `retired` and leaves everyone
HR still lists `active`.

Three groups are deliberately NOT retired:

  * The IT-STORE ghost, which is an account rather than a person.
  * The TTS#### codes — interns. HR's `employees` table does not carry them at
    all, so their absence says nothing about whether they are still here.
  * Anyone handed a device recently. The HR list is a snapshot, and people who
    joined after it was taken look exactly like people who left before it. What
    tells them apart is direction: a leaver hands machines BACK, they do not
    receive one. VPHN354 was issued a device the same day this ran and VPHN358
    two days before — both would have been marked as having left.

All three are listed for a human to tick rather than guessed at. Retiring someone
who still works here is the expensive mistake; leaving a leaver active is not.

Retired is NOT the trash. Someone who has left keeps their row so their handover
history still reads and so the machines they never gave back stay chaseable —
which is the point of the LEAVERS STILL HOLDING report at the end. `deleted_at`
remains what it always was: for rows entered by mistake.

    docker compose exec api python -m be.mark_leavers           # dry run
    docker compose exec api python -m be.mark_leavers --apply   # write
"""
import asyncio
import json
import re
import sys
from datetime import date, timedelta
from pathlib import Path

import asyncpg

from .config import settings
from .repositories import user as user_repo

ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT / "employees_import.json"
BACKUP_FILE = ROOT / "users_before_status_seed.json"

GHOST_CODE = user_repo.GHOST_CODE
# Interns. HR does not track them, so "not in HR" means nothing here.
INTERN_CODE = re.compile(r"^TTS\d+$", re.IGNORECASE)

# Having been issued a device this recently outweighs an absent HR record: the
# export is a snapshot and a new joiner is not in it yet. Wide on purpose — the
# cost of asking about one extra person is nothing next to telling the ledger a
# current colleague has left.
RECENT_DAYS = 90


def classify(
    hr_codes: set[str], current: list[dict], cutoff: date
) -> dict[str, list]:
    """Split the ledger against the HR list. Pure — no I/O."""
    groups: dict[str, list] = {
        "RETIRE": [], "INTERN": [], "RECENT": [], "ALREADY": [], "STAYS_ACTIVE": [],
    }
    for row in current:
        code = row["employee_code"]
        if code == GHOST_CODE:
            continue
        if code in hr_codes:
            groups["STAYS_ACTIVE"].append(code)
        elif INTERN_CODE.match(code):
            groups["INTERN"].append(row)
        elif row["status"] == user_repo.RETIRED:
            groups["ALREADY"].append(code)
        elif row["last_received"] and row["last_received"] >= cutoff:
            groups["RECENT"].append(row)
        else:
            groups["RETIRE"].append(row)
    for rows in groups.values():
        rows.sort(key=lambda r: r if isinstance(r, str) else r["employee_code"])
    return groups


async def run(apply: bool) -> None:
    hr_codes = {
        (e.get("staff_code") or "").strip()
        for e in json.loads(DATA_FILE.read_text(encoding="utf-8"))
    } - {""}

    pool = await asyncpg.create_pool(dsn=settings.database_url, min_size=1, max_size=2)
    try:
        current = [
            dict(r)
            for r in await pool.fetch(
                "SELECT u.employee_code, u.name, u.team, u.status, u.deleted_at, "
                "(SELECT count(*) FROM devices d "
                " WHERE d.user_id = u.employee_code AND d.deleted_at IS NULL) AS held, "
                "(SELECT max(h.handover_date) FROM handovers h "
                " WHERE h.to_user_id = u.employee_code AND h.deleted_at IS NULL)"
                "  AS last_received "
                "FROM users u ORDER BY u.employee_code"
            )
        ]
        cutoff = date.today() - timedelta(days=RECENT_DAYS)
        groups = classify(hr_codes, current, cutoff)

        print(f"HR lists {len(hr_codes)} people; the ledger holds {len(current)}.")
        print(f"Anyone issued a device since {cutoff} is left active.\n")

        print(f"== RETIRE ({len(groups['RETIRE'])}) — no HR record ==")
        for r in groups["RETIRE"]:
            held = f"  ⚠ still holds {r['held']}" if r["held"] else ""
            print(f"  {r['employee_code']:<10} {(r['name'] or '-'):<26}"
                  f" {(r['team'] or '-'):<14}{held}")

        print(f"\n== RECENT ({len(groups['RECENT'])}) — issued a device lately, "
              "left ACTIVE ==")
        print("   Not in HR, but receiving a machine is what a joiner does, not a")
        print("   leaver — the HR snapshot simply predates them.")
        for r in groups["RECENT"]:
            print(f"  {r['employee_code']:<10} {(r['name'] or '-'):<26}"
                  f" {(r['team'] or '-'):<14} last issued {r['last_received']}")

        print(f"\n== INTERN ({len(groups['INTERN'])}) — left ACTIVE, tick by hand ==")
        for r in groups["INTERN"]:
            held = f"  (holds {r['held']})" if r["held"] else ""
            print(f"  {r['employee_code']:<10} {(r['name'] or '-'):<26}{held}")

        print(f"\n== STAYS ACTIVE ({len(groups['STAYS_ACTIVE'])}) ==")
        print(f"== ALREADY RETIRED ({len(groups['ALREADY'])}) ==")

        holding = [r for r in groups["RETIRE"] if r["held"]]
        if holding:
            total = sum(r["held"] for r in holding)
            print(f"\n== LEAVERS STILL HOLDING ({len(holding)} people, {total} devices) ==")
            print("   These machines were never handed back. Collect or reassign them.")
            for r in holding:
                print(f"  {r['employee_code']:<10} {(r['name'] or '-'):<26} {r['held']}")

        if not groups["RETIRE"]:
            print("\nNothing to change.")
            return
        if not apply:
            print(f"\n{len(groups['RETIRE'])} person(s) would be marked retired. "
                  "Re-run with --apply to write.")
            return

        BACKUP_FILE.write_text(
            json.dumps(
                [{k: (v.isoformat() if hasattr(v, "isoformat") else v)
                  for k, v in r.items()} for r in current],
                ensure_ascii=False, indent=2,
            ),
            encoding="utf-8",
        )
        print(f"\nBacked up {len(current)} user row(s) to {BACKUP_FILE.name}")

        codes = [r["employee_code"] for r in groups["RETIRE"]]
        await pool.execute(
            "UPDATE users SET status = $1 WHERE employee_code = ANY($2::varchar[])",
            user_repo.RETIRED, codes,
        )
        print(f"Marked {len(codes)} person(s) retired.")
    finally:
        await pool.close()


if __name__ == "__main__":
    unknown = [a for a in sys.argv[1:] if a != "--apply"]
    if unknown:
        sys.exit(f"Unknown argument(s): {' '.join(unknown)}. Only --apply is accepted.")
    asyncio.run(run("--apply" in sys.argv[1:]))
