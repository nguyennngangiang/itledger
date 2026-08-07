"""One-off: reconcile users.name in a LIVE database with REAL-DATA.xlsx.

Why this exists instead of re-running `be.import_real`: that script TRUNCATEs all
five tables (it is a from-scratch loader), which would throw away everything
entered or corrected in the app since the first import. This one touches exactly
one column — users.name — one row at a time, and only prints what it would do
unless you pass --apply.

    node _build_import.mjs                                       # refresh the json
    docker compose exec api python -m be.fix_user_names           # dry run
    docker compose exec api python -m be.fix_user_names --apply   # write

Rows are sorted into four groups:

  RENAME   both sides hold a person's name and they differ — the fix this exists
           for (VPHN216 "Nguyễn Thị Vân" -> "Nguyễn Minh Quân")
  CLEAR    the workbook has no full name for a code that currently has one,
           because nicknames are no longer stored as names (see _build_import.mjs)
  RESTORE  the DB has no name and the workbook supplies one
  SKIP     codes listed under `conflicts` in import_names_report.json that are
           not in NAME_DECISIONS: the workbook pairs one code with two DIFFERENT
           people, so a human decides — never this script
  ABSENT   codes in the workbook that no longer exist in the DB — reported only,
           never created; this script does not add or delete users
"""
import asyncio
import json
import sys
from pathlib import Path

import asyncpg

from .config import settings
from .models.user import UserUpdate
from .repositories import user as user_repo

ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT / "import_data.json"
REPORT_FILE = ROOT / "import_names_report.json"
# Written just before the first write. CLEAR deletes names that exist nowhere
# else once the workbook stops supplying them, so keep a copy to restore from.
BACKUP_FILE = ROOT / "users_before_name_fix.json"

# Conflicts a human has already ruled on: the workbook names two different people
# for these codes, and this is the answer. Anything here is written like a normal
# rename; every other conflict stays untouched. A decision only applies while it
# still matches what the workbook resolves to — if the source changes underneath,
# the code drops back to SKIP rather than silently writing a stale answer.
NAME_DECISIONS = {
    # ben.pham, 2026-07-30. Remark held the previous holder; two Handover rows
    # dated 2026-07-11 state this code explicitly. The bug that started all this.
    "VPHN216": "Nguyễn Minh Quân",
    # VPHN318 = "Phan Thị Ngọc Hải" was ruled here on 2026-07-30 and RETIRED on
    # 2026-08-03 (ben.pham): that ruling read the workbook, which was all we had.
    # The HR export (employee.dump) separates the two people cleanly — VPHN313 is
    # Phan Thị Ngọc Hải and VPHN318 is Lê Yến Nhi — so HR supersedes it.
    # ben.pham, 2026-07-30 — Handover over the Devices sheet's "Phạm Minh Khánh Huyền".
    "VPHN270": "Phạm Thị Khánh Huyền",
}


def classify(wanted: dict[str, str | None], current: dict[str, str | None],
             conflicts: set[str]) -> dict[str, list]:
    """Split the code -> name diff into the groups above."""
    groups: dict[str, list] = {
        "RENAME": [], "RESTORE": [], "CLEAR": [], "SKIP": [], "ABSENT": [],
    }
    for code, new_name in wanted.items():
        if code not in current:
            groups["ABSENT"].append((code, new_name))
            continue
        old_name = current[code]
        if (new_name or None) == (old_name or None):
            continue
        # A conflict is only writable if a human ruled on it AND the workbook still
        # resolves to that same name.
        if code in conflicts and NAME_DECISIONS.get(code) != new_name:
            groups["SKIP"].append((code, old_name, new_name))
        elif not new_name:
            groups["CLEAR"].append((code, old_name, new_name))
        elif not old_name:
            groups["RESTORE"].append((code, old_name, new_name))
        else:
            groups["RENAME"].append((code, old_name, new_name))
    for rows in groups.values():
        rows.sort(key=lambda r: r[0])
    return groups


async def run(apply: bool) -> None:
    data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    report = json.loads(REPORT_FILE.read_text(encoding="utf-8"))

    wanted = {u["employee_code"]: u["name"] for u in data["users"]}
    conflicts = {c["code"] for c in report["conflicts"]}

    pool = await asyncpg.create_pool(dsn=settings.database_url, min_size=1, max_size=2)
    try:
        current = {u["employee_code"]: u["name"] for u in await user_repo.list_users(pool)}
        groups = classify(wanted, current, conflicts)

        print(f"{'APPLY' if apply else 'DRY RUN'} — users in DB: {len(current)}, "
              f"in workbook: {len(wanted)}\n")

        print(f"== RENAME ({len(groups['RENAME'])}) ==")
        for code, old, new in groups["RENAME"]:
            decided = " [human decision]" if code in NAME_DECISIONS else ""
            print(f"  {code:<10} {old!r} -> {new!r}{decided}")

        print(f"\n== RESTORE ({len(groups['RESTORE'])}) — no name in DB, workbook has one ==")
        for code, _old, new in groups["RESTORE"]:
            print(f"  {code:<10} NULL -> {new!r}")

        print(f"\n== CLEAR ({len(groups['CLEAR'])}) — nickname dropped, name set to NULL ==")
        print(f"  These owners will display as their employee code in the app.")
        for code, old, _ in groups["CLEAR"]:
            print(f"  {code:<10} {old!r} -> NULL")

        print(f"\n== SKIP ({len(groups['SKIP'])}) — workbook disagrees on who this is; NOT touched ==")
        for code, old, new in groups["SKIP"]:
            cands = next(c for c in report["conflicts"] if c["code"] == code)["candidates"]
            print(f"  {code:<10} keeping {old!r}; workbook offers "
                  + ", ".join(f"{c['name']!r}" for c in cands))

        print(f"\n== ABSENT ({len(groups['ABSENT'])}) — in workbook, not in DB; ignored ==")
        for code, new in groups["ABSENT"]:
            print(f"  {code:<10} would be {new!r}")

        writes = groups["RENAME"] + groups["RESTORE"] + groups["CLEAR"]
        if not apply:
            print(f"\nNothing written. {len(writes)} row(s) would change "
                  f"({len(groups['RENAME'])} renamed, {len(groups['RESTORE'])} restored, "
                  f"{len(groups['CLEAR'])} cleared).")
            print("Re-run with --apply to write.")
            return

        rows_before = await user_repo.list_users(pool)
        BACKUP_FILE.write_text(
            json.dumps(rows_before, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"\nBacked up {len(rows_before)} user row(s) to {BACKUP_FILE.name} "
              f"before writing.")

        changed = 0
        for code, _old, new in writes:
            row = await user_repo.update(pool, code, UserUpdate(name=new))
            if row is None:
                print(f"  WARN {code} vanished mid-run, skipped")
            else:
                changed += 1
        print(f"\nWrote {changed} row(s). users.name only — no other column, "
              f"table or row touched.")
    finally:
        await pool.close()


if __name__ == "__main__":
    unknown = [a for a in sys.argv[1:] if a != "--apply"]
    if unknown:
        sys.exit(f"Unknown argument(s): {' '.join(unknown)}. Only --apply is accepted.")
    asyncio.run(run("--apply" in sys.argv[1:]))
