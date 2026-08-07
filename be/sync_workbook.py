"""Non-destructive sync of REAL-DATA.xlsx into a LIVE database.

Run `node _build_import.mjs` first — this reads its output (`import_data.json`),
not the xlsx.

    node _build_import.mjs
    docker compose exec api python -m be.sync_workbook           # dry run
    docker compose exec api python -m be.sync_workbook --apply   # write

Why this exists instead of `be.import_real`: that script is a from-scratch loader
and `TRUNCATE`s all five tables, so it would discard everything entered or
corrected in the app since the first import. This one only ever adds or updates,
and prints its whole plan before touching anything.

The safety rules differ per table, because the risk does:

* **users.name** — reuses `fix_user_names`, so the name-ranking rules and the
  human rulings in its `NAME_DECISIONS` live in exactly one place.
* **devices** — field-level diff: only columns that actually differ are written.
  `status` is NOT synced from the workbook; it is re-derived only when the owner
  changes, and only from `active`/`in_stock` (the app's own rule, see
  `CreateDeviceModal.tsx` setOwner). A device someone marked `maintaining` in the
  app must never be dragged back to `active` by a spreadsheet.
* **handovers / maintenance** — insert unseen ids only, never update. These are
  append-only history, and the DB legitimately holds rows the workbook has never
  heard of (anything created in the app).
* **Nothing is ever deleted.** Rows present in the DB but missing from the
  workbook are reported and left alone.

Reads use plain SELECTs here (rather than the repositories' list_* helpers)
because a sync needs to see soft-deleted rows too — otherwise a deleted serial
looks absent and gets re-inserted as a duplicate. All *writes* go through the
repositories so their duplicate/FK error handling applies.
"""
import asyncio
import json
import sys
from datetime import date
from decimal import Decimal
from pathlib import Path

import asyncpg

from .config import settings
from .fix_user_names import NAME_DECISIONS, classify as classify_names
from .models.device import DeviceCreate, DeviceUpdate
from .models.handover import HandoverCreate
from .models.maintenance import MaintenanceCreate
from .models.user import UserUpdate
from .repositories import device as device_repo
from .repositories import handover as handover_repo
from .repositories import maintenance as maintenance_repo
from .repositories import user as user_repo
from .repositories.errors import DuplicateError, ForeignKeyError

ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT / "import_data.json"
REPORT_FILE = ROOT / "import_names_report.json"
BACKUP_FILE = ROOT / "workbook_sync_backup.json"

GHOST = "IT-STORE"

# Device columns the workbook owns. `status` is deliberately absent — see docstring.
DEVICE_FIELDS = (
    "barcode", "type", "brand", "cpu", "ram", "storage", "os", "msoffice",
    "buy_date", "name", "user_id",
)
# The only two statuses the owner implies. Anything else is a human's call.
DERIVABLE_STATUS = {"active", "in_stock"}

# Fields where a human ruled that the DB wins over the workbook. Needed because a
# sync is re-run: without this the next run silently undoes the ruling.
DB_WINS: dict[str, set[str]] = {
    # ben.pham, 2026-07-30: Giang (VPHN258) keeps this HP. The workbook only lists
    # it in the "Device code" catalog, which carries owner IT-STORE for every row,
    # so a plain sync would take it off her. HO-232/233 record the swap that
    # prompted the question.
    "5CD3307YZN": {"user_id", "status"},
}


def norm(value):
    """Comparable form: the DB hands back date/Decimal, the JSON has strings."""
    if value is None or value == "":
        return None
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    return str(value)


def derived_status(owner: str | None, current: str | None) -> str | None:
    """The status an owner change implies, or None to leave it alone."""
    if current not in DERIVABLE_STATUS:
        return None
    want = "in_stock" if owner in (None, GHOST) else "active"
    return want if want != current else None


def plan_devices(wanted: list[dict], current: dict[str, dict]) -> tuple[list, list]:
    """(updates, inserts). An update is (serial, {field: (old, new)})."""
    updates, inserts = [], []
    for row in wanted:
        serial = row["serial_number"]
        have = current.get(serial)
        if have is None:
            inserts.append(row)
            continue
        pinned = DB_WINS.get(serial, frozenset())
        changed = {
            f: (have.get(f), row.get(f))
            for f in DEVICE_FIELDS
            if f not in pinned and norm(have.get(f)) != norm(row.get(f))
        }
        if "user_id" in changed:
            new_status = derived_status(row.get("user_id"), have.get("status"))
            if new_status and "status" not in pinned:
                changed["status"] = (have.get("status"), new_status)
        if changed:
            updates.append((serial, changed))
    updates.sort(key=lambda u: u[0])
    inserts.sort(key=lambda r: r["serial_number"])
    return updates, inserts


async def snapshot(pool) -> dict:
    """Everything we need to diff against, soft-deleted rows included."""
    devices = await pool.fetch(
        "SELECT serial_number, barcode, type, brand, cpu, ram, storage, os, "
        "msoffice, buy_date, name, user_id, status, deleted_at FROM devices"
    )
    users = await pool.fetch("SELECT employee_code, name, team FROM users")
    ho = await pool.fetch("SELECT handover_id FROM handovers")
    mx = await pool.fetch("SELECT maintenance_id FROM maintenance")
    return {
        "devices": {r["serial_number"]: dict(r) for r in devices},
        "users": {r["employee_code"]: dict(r) for r in users},
        "handover_ids": {r["handover_id"] for r in ho},
        "maintenance_ids": {r["maintenance_id"] for r in mx},
    }


async def run(apply: bool) -> None:
    data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    report = json.loads(REPORT_FILE.read_text(encoding="utf-8"))
    conflicts = {c["code"] for c in report["conflicts"]}

    pool = await asyncpg.create_pool(dsn=settings.database_url, min_size=1, max_size=2)
    try:
        snap = await snapshot(pool)

        name_groups = classify_names(
            {u["employee_code"]: u["name"] for u in data["users"]},
            {c: u["name"] for c, u in snap["users"].items()},
            conflicts,
        )
        name_writes = (
            name_groups["RENAME"] + name_groups["RESTORE"] + name_groups["CLEAR"]
        )
        dev_updates, dev_inserts = plan_devices(data["devices"], snap["devices"])
        new_ho = [h for h in data["handovers"]
                  if h["handover_id"] not in snap["handover_ids"]]
        new_mx = [m for m in data["maintenance"]
                  if m["maintenance_id"] not in snap["maintenance_ids"]]
        orphan_ho = len(snap["handover_ids"]) - (
            len(data["handovers"]) - len(new_ho))
        orphan_mx = len(snap["maintenance_ids"]) - (
            len(data["maintenance"]) - len(new_mx))

        print(f"{'APPLY' if apply else 'DRY RUN'} — workbook: "
              f"{len(data['devices'])} devices, {len(data['handovers'])} handovers, "
              f"{len(data['maintenance'])} maintenance, {len(data['users'])} users")
        print(f"DB     : {len(snap['devices'])} devices, "
              f"{len(snap['handover_ids'])} handovers, "
              f"{len(snap['maintenance_ids'])} maintenance, "
              f"{len(snap['users'])} users\n")

        print(f"== DEVICE UPDATE ({len(dev_updates)}) ==")
        for serial, changed in dev_updates:
            bits = ", ".join(f"{f}: {old!r} -> {new!r}"
                             for f, (old, new) in sorted(changed.items()))
            print(f"  {serial:<18} {bits}")

        print(f"\n== DEVICE INSERT ({len(dev_inserts)}) ==")
        for row in dev_inserts:
            print(f"  {row['serial_number']:<18} owner={row.get('user_id')} "
                  f"{row.get('type')} {row.get('brand')}")

        print(f"\n== HANDOVER INSERT ({len(new_ho)}) ==")
        for h in new_ho:
            print(f"  {h['handover_id']:<10} {h['handover_date']} {h['device_id']} "
                  f"{h['from_user_id']} -> {h['to_user_id']} ({h['reason']})")

        print(f"\n== MAINTENANCE INSERT ({len(new_mx)}) ==")
        for m in new_mx:
            print(f"  {m['maintenance_id']:<10} {m['maintenance_date']} "
                  f"{m['device_id']} {m['part']}")

        print(f"\n== USER NAME ({len(name_writes)}) ==")
        for code, old, new in name_writes:
            decided = " [human decision]" if code in NAME_DECISIONS else ""
            print(f"  {code:<10} {old!r} -> {new!r}{decided}")
        if name_groups["SKIP"]:
            print(f"  ({len(name_groups['SKIP'])} conflict code(s) left untouched — "
                  f"see be/fix_user_names.py NAME_DECISIONS)")

        print(f"\n== IN DB, NOT IN WORKBOOK — reported only, never deleted ==")
        print(f"  handovers: {orphan_ho}   maintenance: {orphan_mx}   "
              f"devices: {len(snap['devices']) - len(data['devices']) + len(dev_inserts)}")

        total = (len(dev_updates) + len(dev_inserts) + len(new_ho) + len(new_mx)
                 + len(name_writes))
        if not apply:
            print(f"\nNothing written. {total} change(s) would be made.")
            print("Re-run with --apply to write.")
            return
        if not total:
            print("\nNothing to do.")
            return

        BACKUP_FILE.write_text(
            json.dumps(
                {"devices": [{k: norm(v) for k, v in d.items()}
                             for d in snap["devices"].values()],
                 "users": list(snap["users"].values())},
                ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"\nBacked up devices + users to {BACKUP_FILE.name} before writing.")

        done, failed = 0, []
        for serial, changed in dev_updates:
            patch = {f: new for f, (_old, new) in changed.items()}
            try:
                await device_repo.update(pool, serial, DeviceUpdate(**patch))
                done += 1
            except (DuplicateError, ForeignKeyError) as e:
                failed.append(f"device {serial}: {e}")
        for row in dev_inserts:
            try:
                await device_repo.create(pool, DeviceCreate(**row))
                done += 1
            except (DuplicateError, ForeignKeyError) as e:
                failed.append(f"device {row['serial_number']}: {e}")
        for h in new_ho:
            try:
                await handover_repo.create(pool, HandoverCreate(**h))
                done += 1
            except (DuplicateError, ForeignKeyError) as e:
                failed.append(f"handover {h['handover_id']}: {e}")
        for m in new_mx:
            try:
                await maintenance_repo.create(pool, MaintenanceCreate(**m))
                done += 1
            except (DuplicateError, ForeignKeyError) as e:
                failed.append(f"maintenance {m['maintenance_id']}: {e}")
        for code, _old, new in name_writes:
            if await user_repo.update(pool, code, UserUpdate(name=new)) is not None:
                done += 1
            else:
                failed.append(f"user {code}: row vanished mid-run")

        print(f"\nWrote {done} change(s). Nothing was deleted.")
        if failed:
            print(f"{len(failed)} failed:")
            for f in failed:
                print(f"  {f}")
            sys.exit(1)
    finally:
        await pool.close()


if __name__ == "__main__":
    unknown = [a for a in sys.argv[1:] if a != "--apply"]
    if unknown:
        sys.exit(f"Unknown argument(s): {' '.join(unknown)}. Only --apply is accepted.")
    asyncio.run(run("--apply" in sys.argv[1:]))
