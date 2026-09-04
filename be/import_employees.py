"""Merge the HR staff list into users in a LIVE database.

The source is `employee.dump`, a pg_dump of the yic_operation_staging HR
database. `_extract_employees.sh` turns it into employees_import.json first —
extraction and writing are separate steps, same as
_build_import.mjs -> import_data.json -> be.sync_workbook.

Why this exists instead of `be.import_real`: that script TRUNCATEs all five
tables. This one only ever inserts a user, updates users.name / users.team, or
soft-deletes someone HR no longer lists — and prints what it would do unless
you pass --apply.

    wsl -d Ubuntu-24.04 -u root -- bash /mnt/d/itledger/_extract_employees.sh
    docker compose exec api python -m be.import_employees                            # dry run
    docker compose exec api python -m be.import_employees --team-from=department --apply

HR is treated as authoritative for names, with one exception: codes a human has
already ruled on in be.fix_user_names.NAME_DECISIONS keep the ruling. That dict
is imported rather than copied so the rulings live in exactly one place.

Rows are sorted into these groups:

  CREATE      in HR, not in the DB — a new joiner
  RENAME      name differs; HR wins
  RETEAM      team differs; HR wins
  SKIP        a human ruled on this code and HR disagrees — never this script
  LEFT        HR marks them departed — not imported
  LEFT_OWNING departed but still holding devices — those machines want collecting
  TRASH       in the DB, not in HR, holding no devices — soft-deleted (restorable)
  KEEP        in the DB, not in HR, but still holding devices — reported, untouched
"""
import asyncio
import json
import sys
from pathlib import Path

import asyncpg

from .config import settings
from .fix_user_names import NAME_DECISIONS
from .models.user import UserCreate, UserUpdate
from .repositories import user as user_repo

ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT / "employees_import.json"
# Written just before the first write. TRASH soft-deletes people and RENAME
# overwrites names, so keep a copy of every row — including already-trashed
# ones, which is why the snapshot is a plain SELECT and not list_users().
BACKUP_FILE = ROOT / "users_before_employee_import.json"

GHOST_CODE = user_repo.GHOST_CODE

TEAM_SOURCES = ("department", "division", "division_code")


def team_of(row: dict, source: str) -> str | None:
    """The team for one HR row, falling back when the chosen column is blank.

    A couple of HR rows carry a division but no department, so preferring the
    chosen source and falling back beats writing NULL over a good value.
    """
    order = [source] + [s for s in TEAM_SOURCES if s != source]
    for key in order:
        value = (row.get(key) or "").strip()
        if value:
            return value
    return None


def classify(
    hr: list[dict],
    current: dict[str, dict],
    owned: dict[str, int],
    team_source: str,
) -> dict[str, list]:
    """Split the HR list vs the DB into the groups above. Pure — no I/O."""
    groups: dict[str, list] = {
        "CREATE": [], "RENAME": [], "RETEAM": [], "SKIP": [],
        "LEFT": [], "LEFT_OWNING": [], "TRASH": [], "KEEP": [], "UNCHANGED": [],
    }
    seen: set[str] = set()

    for row in hr:
        code = (row.get("staff_code") or "").strip()
        if not code:
            continue
        seen.add(code)
        name = (row.get("name") or "").strip() or None
        team = team_of(row, team_source)
        departed = not row.get("is_active") or bool(row.get("last_working_day"))

        if departed:
            held = owned.get(code, 0)
            (groups["LEFT_OWNING"] if held else groups["LEFT"]).append((code, name, held))
            continue

        if code not in current:
            groups["CREATE"].append((code, name, team))
            continue

        old = current[code]
        old_name = (old["name"] or "").strip() or None
        old_team = (old["team"] or "").strip() or None
        touched = False

        # A human ruling wins over HR, but only while it still names the person
        # the DB actually holds — otherwise the ruling has gone stale and the
        # row is left alone rather than written from a guess.
        if name and name != old_name:
            if code in NAME_DECISIONS and NAME_DECISIONS[code] != name:
                groups["SKIP"].append((code, old_name, name))
            else:
                groups["RENAME"].append((code, old_name, name))
                touched = True
        if team and team != old_team:
            groups["RETEAM"].append((code, old_team, team))
            touched = True
        if not touched and code not in {c for c, *_ in groups["SKIP"]}:
            groups["UNCHANGED"].append((code,))

    for code, row in current.items():
        if code in seen or code == GHOST_CODE:
            continue  # the ghost holds every in-stock device; never touch it
        held = owned.get(code, 0)
        entry = (code, (row["name"] or "").strip() or None, held)
        if row["deleted_at"] is not None:
            continue  # already in the trash, leave it there
        (groups["KEEP"] if held else groups["TRASH"]).append(entry)

    for rows in groups.values():
        rows.sort(key=lambda r: r[0])
    return groups


async def snapshot(pool: asyncpg.Pool) -> list[dict]:
    """Every user row, trashed ones included — a backup that omits them cannot
    restore them."""
    rows = await pool.fetch(
        "SELECT employee_code, name, team, deleted_at FROM users ORDER BY employee_code"
    )
    return [
        {
            "employee_code": r["employee_code"],
            "name": r["name"],
            "team": r["team"],
            "deleted_at": r["deleted_at"].isoformat() if r["deleted_at"] else None,
        }
        for r in rows
    ]


def report_team_sources(hr: list[dict], current: dict[str, dict]) -> None:
    """Which HR column lines up best with the teams already in use."""
    db_teams = {(v["team"] or "").strip().lower() for v in current.values()} - {""}
    print("== TEAM SOURCE COMPARISON ==")
    print(f"  {len(db_teams)} distinct teams currently in the DB")
    for source in TEAM_SOURCES:
        values = {(r.get(source) or "").strip() for r in hr} - {""}
        matched = {v for v in values if v.lower() in db_teams}
        blank = sum(1 for r in hr if not (r.get(source) or "").strip())
        print(f"  {source:<14} {len(values):>3} distinct  "
              f"{len(matched):>3} already used  {len(values) - len(matched):>3} new  "
              f"{blank:>3} blank rows")


async def run(apply: bool, team_source: str) -> None:
    hr = json.loads(DATA_FILE.read_text(encoding="utf-8"))

    pool = await asyncpg.create_pool(dsn=settings.database_url, min_size=1, max_size=2)
    try:
        current = {
            r["employee_code"]: dict(r)
            for r in await pool.fetch(
                "SELECT employee_code, name, team, deleted_at FROM users"
            )
        }
        owned = {
            r["user_id"]: r["count"]
            for r in await pool.fetch(
                "SELECT user_id, count(*) FROM devices "
                "WHERE deleted_at IS NULL AND user_id IS NOT NULL GROUP BY user_id"
            )
        }

        print(f"{'APPLY' if apply else 'DRY RUN'} — users in DB: {len(current)}, "
              f"in HR export: {len(hr)}, team from: {team_source}\n")
        report_team_sources(hr, current)

        groups = classify(hr, current, owned, team_source)

        print(f"\n== CREATE ({len(groups['CREATE'])}) — new joiners ==")
        for code, name, team in groups["CREATE"]:
            print(f"  {code:<12} {name!r:<32} team={team!r}")

        print(f"\n== RENAME ({len(groups['RENAME'])}) — HR wins ==")
        for code, old, new in groups["RENAME"]:
            decided = " [human decision matches HR]" if code in NAME_DECISIONS else ""
            print(f"  {code:<12} {old!r} -> {new!r}{decided}")

        print(f"\n== RETEAM ({len(groups['RETEAM'])}) — HR wins ==")
        for code, old, new in groups["RETEAM"]:
            print(f"  {code:<12} {old!r} -> {new!r}")

        print(f"\n== SKIP ({len(groups['SKIP'])}) — a human ruled on this code; NOT touched ==")
        for code, old, new in groups["SKIP"]:
            print(f"  {code:<12} keeping {old!r}; HR says {new!r} "
                  f"(ruling: {NAME_DECISIONS[code]!r})")

        print(f"\n== LEFT ({len(groups['LEFT'])}) — HR marks departed; not imported ==")
        for code, name, _ in groups["LEFT"]:
            print(f"  {code:<12} {name!r}")

        print(f"\n== LEFT BUT STILL HOLDING ({len(groups['LEFT_OWNING'])}) "
              f"— departed, devices to collect ==")
        for code, name, held in groups["LEFT_OWNING"]:
            print(f"  {code:<12} {name!r} still holds {held} device(s)")

        print(f"\n== TRASH ({len(groups['TRASH'])}) — not in HR, holding nothing; "
              f"soft-deleted (restorable) ==")
        for code, name, _ in groups["TRASH"]:
            print(f"  {code:<12} {name!r}")

        print(f"\n== KEEP ({len(groups['KEEP'])}) — not in HR but still holding devices; "
              f"untouched ==")
        for code, name, held in groups["KEEP"]:
            print(f"  {code:<12} {name!r} holds {held} device(s)")

        print(f"\n== UNCHANGED ({len(groups['UNCHANGED'])}) ==")

        writes = (len(groups["CREATE"]) + len(groups["RENAME"])
                  + len(groups["RETEAM"]) + len(groups["TRASH"]))
        if not apply:
            print(f"\nNothing written. {writes} row(s) would change "
                  f"({len(groups['CREATE'])} created, {len(groups['RENAME'])} renamed, "
                  f"{len(groups['RETEAM'])} re-teamed, {len(groups['TRASH'])} trashed).")
            print(f"Re-run with --team-from={team_source} --apply to write.")
            return

        rows_before = await snapshot(pool)
        BACKUP_FILE.write_text(
            json.dumps(rows_before, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"\nBacked up {len(rows_before)} user row(s) (trashed ones included) "
              f"to {BACKUP_FILE.name} before writing.")

        created = renamed = reteamed = trashed = 0
        failed: list[str] = []

        for code, name, team in groups["CREATE"]:
            try:
                await user_repo.create(pool, UserCreate(
                    employee_code=code, name=name, team=team))
                created += 1
            except Exception as e:  # DuplicateError and friends
                failed.append(f"create {code}: {e}")

        # RENAME and RETEAM can name the same code; send one PATCH per code.
        patches: dict[str, dict] = {}
        for code, _old, new in groups["RENAME"]:
            patches.setdefault(code, {})["name"] = new
        for code, _old, new in groups["RETEAM"]:
            patches.setdefault(code, {})["team"] = new
        for code, fields in sorted(patches.items()):
            row = await user_repo.update(pool, code, UserUpdate(**fields))
            if row is None:
                failed.append(f"update {code}: row vanished mid-run")
                continue
            renamed += "name" in fields
            reteamed += "team" in fields

        for code, _name, _held in groups["TRASH"]:
            try:
                if await user_repo.delete(pool, code):
                    trashed += 1
            except Exception as e:  # ProtectedError / InUseError
                failed.append(f"trash {code}: {e}")

        print(f"\nWrote: {created} created, {renamed} renamed, {reteamed} re-teamed, "
              f"{trashed} moved to trash.")
        print("users only — devices, handovers and maintenance were not touched, "
              "and nothing was permanently deleted.")
        if failed:
            print(f"\n{len(failed)} operation(s) failed:")
            for line in failed:
                print(f"  {line}")
            sys.exit(1)
    finally:
        await pool.close()


if __name__ == "__main__":
    args = sys.argv[1:]
    team_source = "department"
    unknown = []
    for arg in args:
        if arg == "--apply":
            continue
        if arg.startswith("--team-from="):
            team_source = arg.split("=", 1)[1]
            if team_source not in TEAM_SOURCES:
                sys.exit(f"--team-from must be one of {', '.join(TEAM_SOURCES)}")
            continue
        unknown.append(arg)
    if unknown:
        sys.exit(f"Unknown argument(s): {' '.join(unknown)}. "
                 f"Only --apply and --team-from= are accepted.")
    asyncio.run(run("--apply" in args, team_source))
