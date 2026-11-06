"""Export the ledger as three flat CSVs the GLPI `yicledger` importer accepts.

We are moving the asset ledger into GLPI 11. Its importer
(`/plugins/yicledger/front/import.php`) reads one flat sheet at a time and
matches assets by **serial number only**, and people by employee code through
`glpi_users.sync_field = 'op:staff:<CODE>'` (filled by the `yicorgsync` plugin).

So this writes three files, never mixed, and they must be imported in this order:

    1. itledger_devices_<YYYYMMDD>.csv
    2. itledger_handovers_<YYYYMMDD>.csv
    3. itledger_maintenance_<YYYYMMDD>.csv

Handovers and maintenance fail on any serial GLPI does not know yet, which is
why devices go first.

    python -m be.export_glpi --out DIR [--since YYYY-MM-DD]
                             [--only devices|handovers|maintenance]

Three decisions worth knowing about, because they are not obvious:

* **Devices are always exported in full.** `--since` filters handovers and
  maintenance only. The ledger tables carry no `updated_at` column, so there is
  nothing to filter a device delta on. A full device file is cheap and the
  importer never overwrites an existing serial, so re-sending every device is
  safe. If a real delta is ever needed, add `updated_at` with a trigger.

* **The importer dedups on the date.** Handovers key on (asset, date, from, to)
  and maintenance on (asset, date, part), so a row with no date defeats dedup
  and would be re-created on every run. Undated rows are therefore dropped, and
  counted in the warnings rather than written.

* **Newlines inside a value are replaced with a space.** The importer wants a
  flat sheet. RFC 4180 can quote an embedded newline correctly, but a
  multi-line cell is exactly the shape that turns into a half-parsed row
  somewhere downstream. The substitution is counted as a warning so it is never
  silent.

Output is deterministic: ordered by key in SQL, so two runs over unchanged data
produce byte-identical files apart from the date in the name.
"""
import argparse
import asyncio
import csv
import re
import sys
from collections import Counter
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

import asyncpg

from .config import settings
from .constants import GHOST_CODE
from .repositories import export as repo

# Headers must stay exactly as written: the importer normalises a header
# (lowercase, strip accents, đ→d, drop everything but a-z0-9) and also guesses
# the kind of file from the header words. Renaming a column breaks both.
DEVICE_HEADER = [
    "Serial Number", "Barcode", "Type", "Brand", "CPU", "RAM", "Storage",
    "OS", "MS Office", "Buy Date", "Device Name", "Owner", "Status",
]
HANDOVER_HEADER = ["Serial", "Handover Date", "From", "To", "Reason"]
MAINTENANCE_HEADER = [
    "Serial", "Maintenance Date", "Team", "Part", "Reason", "Solution",
    "Result", "Cost", "Remarks",
]

# Statuses the importer understands. Anything else it silently files as
# in_stock, so an unknown value is reported rather than quietly reshaped here.
KNOWN_STATUSES = frozenset({"active", "in_stock", "maintaining", "on_del"})

# Types the importer maps to a GLPI asset class. Anything else becomes a
# Computer — fine as a default, worth a warning when it happens by accident.
KNOWN_TYPES = frozenset({
    "laptop", "notebook", "desktop", "pc", "aio", "workstation", "server",
    "macbook", "imac", "monitor", "keyboard", "mouse", "dock", "scanner",
    "headset", "printer", "phone", "tablet", "ipad", "switch", "router",
})

# A handover Reason is capped at 255 by the importer.
REASON_MAX = 255

_WS_RUN = re.compile(r"[\r\n\t\v\f]+")


class Warnings:
    """Collects everything a human should look at before importing.

    Kept as counts plus a bounded sample: a ledger with four thousand devices
    and one systematic mistake should print one line, not four thousand.
    """

    SAMPLE = 5

    def __init__(self) -> None:
        self._counts: Counter[str] = Counter()
        self._samples: dict[str, list[str]] = {}

    def add(self, kind: str, detail: str = "") -> None:
        self._counts[kind] += 1
        if detail:
            seen = self._samples.setdefault(kind, [])
            if len(seen) < self.SAMPLE:
                seen.append(detail)

    def __bool__(self) -> bool:
        return bool(self._counts)

    def lines(self) -> list[str]:
        out = []
        for kind, n in sorted(self._counts.items()):
            line = f"  {n:6d}  {kind}"
            sample = self._samples.get(kind)
            if sample:
                more = "" if n <= len(sample) else f", … (+{n - len(sample)})"
                line += "  e.g. " + "; ".join(sample) + more
            out.append(line)
        return out


def clean(value, warn: Warnings | None = None, where: str = "") -> str:
    """Trim; whitespace-only becomes empty; inner newlines become one space.

    Never returns the strings "NULL", "-" or "N/A" for a missing value — those
    are real text to the importer, so a missing value is always "".
    """
    if value is None:
        return ""
    text = str(value)
    flattened = _WS_RUN.sub(" ", text)
    if flattened != text and warn is not None:
        warn.add("value contained a line break (replaced with a space)", where)
    return flattened.strip()


def iso_date(value, warn: Warnings | None = None, where: str = "") -> str:
    """`YYYY-MM-DD`, or "" when there is no usable date."""
    if value is None or value == "":
        return ""
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    text = str(value).strip()
    try:
        return date.fromisoformat(text[:10]).isoformat()
    except ValueError:
        if warn is not None:
            warn.add("unparseable date (left empty)", f"{where}={text!r}")
        return ""


def code(value, warn: Warnings | None = None, where: str = "") -> str:
    """Employee code, trimmed and upper-cased.

    The importer tries the code as given and then upper-cased, so sending it
    upper-cased is simply one less thing that can miss. A code that was not
    already upper-case is reported: it usually means the ledger row was typed
    by hand, and the OP/`yicorgsync` side may hold a different spelling.
    """
    text = clean(value)
    if not text:
        return ""
    upper = text.upper()
    if upper != text and warn is not None:
        warn.add("employee code was not upper-case (upper-cased)", f"{where}={text!r}")
    return upper


def vnd(value, warn: Warnings | None = None, where: str = "") -> str:
    """Plain non-negative integer, no separators, no currency sign."""
    if value is None or value == "":
        return ""
    try:
        amount = Decimal(str(value))
    except Exception:
        if warn is not None:
            warn.add("unparseable cost (left empty)", f"{where}={value!r}")
        return ""
    if amount < 0:
        if warn is not None:
            warn.add("negative cost (left empty)", f"{where}={amount}")
        return ""
    whole = amount.to_integral_value(rounding="ROUND_HALF_UP")
    if whole != amount and warn is not None:
        warn.add("cost had a fractional part (rounded)", f"{where}={amount}")
    return str(int(whole))


# ---------------------------------------------------------------- row builders
# Pure: rows in, rows out. No database, so they are the part worth unit-testing.


def device_rows(records, warn: Warnings) -> list[list[str]]:
    rows: list[list[str]] = []
    seen: set[str] = set()
    for r in records:
        serial = clean(r["serial_number"], warn, "device serial")
        if not serial:
            warn.add("device with no serial (skipped)")
            continue
        if serial in seen:
            warn.add("duplicate serial after trimming (skipped)", serial)
            continue
        seen.add(serial)

        kind = clean(r["type"])
        if kind and kind.lower() not in KNOWN_TYPES:
            warn.add("unmapped device type (GLPI will file it as Computer)", f"{serial}={kind!r}")

        status = clean(r["status"])
        if status and status not in KNOWN_STATUSES:
            warn.add("unknown status (GLPI will file it as in_stock)", f"{serial}={status!r}")

        rows.append([
            serial,
            clean(r["barcode"], warn, f"{serial}.barcode"),
            kind,
            clean(r["brand"], warn, f"{serial}.brand"),
            clean(r["cpu"], warn, f"{serial}.cpu"),
            clean(r["ram"], warn, f"{serial}.ram"),
            clean(r["storage"], warn, f"{serial}.storage"),
            clean(r["os"], warn, f"{serial}.os"),
            clean(r["msoffice"], warn, f"{serial}.msoffice"),
            iso_date(r["buy_date"], warn, f"{serial}.buy_date"),
            clean(r["name"], warn, f"{serial}.name"),
            code(r["user_id"], warn, f"{serial}.owner"),
            status,
        ])
    return rows


def handover_rows(records, warn: Warnings) -> list[list[str]]:
    """Caller must supply records already ordered by (date, handover_id).

    The importer walks the file top to bottom and carries each asset's holder
    from one row to the next, so order is part of the data.
    """
    rows: list[list[str]] = []
    seen: set[tuple[str, str, str, str]] = set()
    for r in records:
        hid = clean(r["handover_id"])
        serial = clean(r["device_id"], warn, f"handover {hid}.serial")
        if not serial:
            warn.add("handover with no serial (skipped)", hid)
            continue
        when = iso_date(r["handover_date"], warn, f"handover {hid}.date")
        if not when:
            # No date means the importer stamps its own run date and the dedup
            # key stops matching, so the row would be re-created on every run.
            warn.add("handover with no date (skipped — would break dedup)", f"{hid} {serial}")
            continue
        to_user = code(r["to_user_id"], warn, f"handover {hid}.to")
        if not to_user:
            warn.add("handover with no recipient (skipped)", f"{hid} {serial}")
            continue
        from_user = code(r["from_user_id"], warn, f"handover {hid}.from")
        if from_user and from_user == to_user:
            warn.add("handover from and to are the same person (skipped)", f"{hid} {to_user}")
            continue

        key = (serial, when, from_user, to_user)
        if key in seen:
            warn.add("duplicate handover (serial, date, from, to) (skipped)", f"{hid} {serial} {when}")
            continue
        seen.add(key)

        reason = clean(r["reason"], warn, f"handover {hid}.reason")
        if len(reason) > REASON_MAX:
            warn.add(f"reason longer than {REASON_MAX} chars (truncated)", f"{hid} {serial}")
            reason = reason[:REASON_MAX]

        rows.append([serial, when, from_user, to_user, reason])
    return rows


def maintenance_rows(records, warn: Warnings) -> list[list[str]]:
    rows: list[list[str]] = []
    seen: set[tuple[str, str, str]] = set()
    for r in records:
        mid = clean(r["maintenance_id"])
        serial = clean(r["device_id"], warn, f"maintenance {mid}.serial")
        if not serial:
            warn.add("maintenance with no serial (skipped)", mid)
            continue
        when = iso_date(r["maintenance_date"], warn, f"maintenance {mid}.date")
        if not when:
            warn.add("maintenance with no date (skipped — would break dedup)", f"{mid} {serial}")
            continue
        part = clean(r["part"], warn, f"maintenance {mid}.part")

        key = (serial, when, part)
        if key in seen:
            warn.add("duplicate maintenance (serial, date, part) (skipped)", f"{mid} {serial} {when}")
            continue
        seen.add(key)

        rows.append([
            serial,
            when,
            clean(r["team"], warn, f"maintenance {mid}.team"),
            part,
            clean(r["reason"], warn, f"maintenance {mid}.reason"),
            clean(r["solution"], warn, f"maintenance {mid}.solution"),
            clean(r["result"], warn, f"maintenance {mid}.result"),
            vnd(r["cost_vnd"], warn, f"maintenance {mid}.cost"),
            clean(r["remarks"], warn, f"maintenance {mid}.remarks"),
        ])
    return rows


# ---------------------------------------------------------------------- output

def to_csv(header: list[str], rows: list[list[str]]) -> str:
    """CSV text per RFC 4180: comma, `"` quoting, CRLF. No BOM — see write_csv."""
    import io

    buf = io.StringIO(newline="")
    w = csv.writer(buf, delimiter=",", quotechar='"', quoting=csv.QUOTE_MINIMAL,
                   lineterminator="\r\n")
    w.writerow(header)
    w.writerows(rows)
    return buf.getvalue()


def write_csv(path: Path, header: list[str], rows: list[list[str]]) -> None:
    """UTF-8 **with BOM** so Excel opens Vietnamese text without mangling it."""
    path.write_text(to_csv(header, rows), encoding="utf-8-sig", newline="")


# ------------------------------------------------------------------ data access
# The SQL itself lives in repositories/export.py, per the repo's rule that no
# statement sits outside repositories/. `pool` here may be a plain connection:
# asyncpg gives Pool and Connection the same `.fetch`.


async def fetch(pool, since: date | None) -> dict[str, list]:
    return {
        "devices": await repo.devices(pool),
        "handovers": await repo.handovers(pool, since),
        "maintenance": await repo.maintenance(pool, since),
    }


async def flag_risky_codes(pool, used: set[str], warn: Warnings) -> None:
    """Warn about codes we are about to export that OP may no longer carry."""
    for row in await repo.risky_codes(pool):
        c = (row["employee_code"] or "").upper()
        if c not in used:
            continue
        why = "soft-deleted in the ledger" if row["removed"] else f"status={row['status']}"
        warn.add("exported code may not be in GLPI (yicorgsync syncs active OP staff)",
                 f"{c} ({why})")


# ---------------------------------------------------------------------- the CLI

def build(data: dict[str, list], only: str | None, warn: Warnings) -> dict[str, tuple]:
    """Build the files asked for. Returns kind -> (filename stem, header, rows)."""
    stamp = date.today().strftime("%Y%m%d")
    builders = {
        "devices": (f"itledger_devices_{stamp}.csv", DEVICE_HEADER, device_rows),
        "handovers": (f"itledger_handovers_{stamp}.csv", HANDOVER_HEADER, handover_rows),
        "maintenance": (f"itledger_maintenance_{stamp}.csv", MAINTENANCE_HEADER, maintenance_rows),
    }
    out = {}
    for kind, (name, header, fn) in builders.items():
        if only and kind != only:
            continue
        out[kind] = (name, header, fn(data[kind], warn))
    return out


def codes_in(built: dict[str, tuple]) -> set[str]:
    """Every employee code the built files mention, for the GLPI sanity check."""
    used: set[str] = set()
    if "devices" in built:
        used |= {r[11] for r in built["devices"][2] if r[11]}
    if "handovers" in built:
        for r in built["handovers"][2]:
            used |= {c for c in (r[2], r[3]) if c}
    return used - {GHOST_CODE}


async def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="python -m be.export_glpi",
        description="Write devices / handovers / maintenance CSVs for the GLPI "
                    "yicledger importer. Import them in that order.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "--since filters handovers and maintenance ONLY. Devices are always\n"
            "exported in full: the ledger has no updated_at column to compute a\n"
            "delta from, and the importer never overwrites a serial it already\n"
            "has, so a full device file is safe to re-send.\n\n"
            "Dedup in GLPI keys on the date, so overlapping windows are safe —\n"
            "use a 1-day overlap between runs."
        ),
    )
    p.add_argument("--out", required=True, type=Path, help="directory to write into")
    p.add_argument("--since", metavar="YYYY-MM-DD",
                   help="keep handovers/maintenance on or after this date")
    p.add_argument("--only", choices=["devices", "handovers", "maintenance"],
                   help="write just one file (mind the import order)")
    args = p.parse_args(argv)

    since: date | None = None
    if args.since:
        try:
            since = date.fromisoformat(args.since)
        except ValueError:
            p.error(f"--since must be YYYY-MM-DD, got {args.since!r}")

    args.out.mkdir(parents=True, exist_ok=True)

    warn = Warnings()
    conn = await asyncpg.connect(dsn=settings.database_url)
    try:
        data = await fetch(conn, since)
        built = build(data, args.only, warn)
        await flag_risky_codes(conn, codes_in(built), warn)
    finally:
        await conn.close()

    print(f"Export → {args.out}" + (f"  (since {since})" if since else ""))
    for kind, (name, header, rows) in built.items():
        write_csv(args.out / name, header, rows)
        read = len(data[kind])
        note = "" if read == len(rows) else f"  ({read - len(rows)} skipped, see warnings)"
        print(f"  {len(rows):6d} rows  {name}{note}")
    if args.only:
        print("  note: --only was given; import devices before handovers before maintenance.")

    if warn:
        print("\nWarnings:")
        for line in warn.lines():
            print(line)
    else:
        print("\nNo warnings.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
