"""Read a flattened handover record WITHOUT the model, when its shape allows it.

The company template is fixed: bilingual labels in one cell, the value in a cell to
the right, and one small item table whose header row carries `SERIAL`. That is a
parse, not a judgement call — so it does not need an 8B model, and paying one costs
real time. Measured against the live `llama3.1:8b`, a fifteen-line record takes
**~25s warm and ~70s cold** (44s of which is Ollama loading the weights) versus
**under a millisecond** here.

The model still earns its place on everything this cannot claim: a scanned record, a
photo, a PDF whose extracted text has no columns left, an older template. So this
returns `None` rather than a half-answer, and `routers/imports` falls back.

**What makes returning a parse safe is that it is checked the same way the model's
answer is.** `handover_import.verify_parsed` re-reads every string against the
source text either way, so a parser bug can only ever drop a value, never invent
one. The extra guard here is `_consistent`: the number of item rows the parse
produced has to equal the number of numbered rows the table actually has, so a
parser that understood the header but choked on row 7 of 15 declines the whole file
instead of quietly importing eight of them.

Two zones, split at the item table's header row. Before it, the form's labelled
fields; after it, the numbered rows. Splitting there is what keeps the signature
block at the bottom — which reads `Bên A | | | | Bên B` — from being read as two
more parties.
"""
import re

# Our own flattener writes `NNN | cell | cell`; `extract.py` hands back markdown
# tables that start with a bare `|`. Both are cell-per-pipe, so both parse.
_ROW_INDEX = re.compile(r"^\s*(\d+)\s*\|")

# A cell that IS a label rather than a value. Needed because a value is "the next
# non-empty cell", and on a row whose name is blank the next non-empty cell is the
# *next label* — `Bên A/ Party A: | | Mã NV/ Code: | VPHN228` would otherwise read
# the name as "Mã NV/ Code:".
_LABEL = re.compile(
    r":\s*$"                                     # anything ending in a colon
    r"|^\s*(m[ãa]\s*nv|code|b[ộo]\s*ph[ậa]n|dept|ch[ứu]c\s*v[ụu]|position"
    r"|[đd][ịi]a\s*[đd]i[ểe]m|place|b[êe]n\s+[a-z]\b|party\s+[a-z]\b)",
    re.I,
)

_PARTY = re.compile(r"^\s*(?:b[êe]n|party)\s+([A-Z])\b", re.I)
_CODE = re.compile(r"m[ãa]\s*nv|\bcode\b", re.I)
_DEPT = re.compile(r"b[ộo]\s*ph[ậa]n|\bdept", re.I)
_POSITION = re.compile(r"ch[ứu]c\s*v[ụu]|\bposition\b", re.I)
_PLACE = re.compile(r"[đd][ịi]a\s*[đd]i[ểe]m|\bplace\b", re.I)

# The flattener appends every date cell's ISO value in brackets — the same thing
# that lets `verify_parsed` check a date at all.
_ISO_DATE = re.compile(r"\[(\d{4}-\d{2}-\d{2})\]")

# Item-table columns, by what the template calls them in either language.
_COLUMNS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("serial", ("serial",)),
    ("no", ("no.", "no", "stt", "tt")),
    ("item", ("nội dung", "noi dung", "item")),
    ("quantity", ("số lượng", "so luong", "quantity", "qty")),
    ("detail", ("chi tiết", "chi tiet", "detail", "description")),
    ("note", ("ghi chú", "ghi chu", "note", "remark")),
)


def _cells(line: str) -> list[str] | None:
    """One flattened line → its cells, or None if the line carries no columns."""
    if "|" not in line:
        return None
    body = line
    index = _ROW_INDEX.match(line)
    if index:
        body = line[index.end():]
    parts = [c.strip() for c in body.split("|")]
    # A markdown table's leading/trailing pipe yields empty edge cells.
    while parts and parts[0] == "":
        parts.pop(0)
    while parts and parts[-1] == "":
        parts.pop()
    return parts or None


def _value_after(cells: list[str], i: int) -> str | None:
    """The value belonging to the label at `i`: the next non-empty cell that is not
    itself a label. See `_LABEL` for why that qualifier is not optional."""
    for cell in cells[i + 1:]:
        if not cell:
            continue
        return None if _LABEL.search(cell) else cell
    return None


def _is_header(cells: list[str]) -> bool:
    """The item table's header row is the one carrying a SERIAL column."""
    return any(c.strip().lower() == "serial" for c in cells)


def _column_map(cells: list[str]) -> dict[str, int]:
    """Header row → {field: column index}. First match wins per column, so a stray
    later cell cannot steal a field from the real header cell."""
    columns: dict[str, int] = {}
    for i, cell in enumerate(cells):
        low = cell.strip().lower()
        if not low:
            continue
        for field, aliases in _COLUMNS:
            if field in columns:
                continue
            if any(alias == low or alias in low for alias in aliases):
                columns[field] = i
                break
    return columns


def _int(value: str | None) -> int | None:
    return int(value) if value and value.strip().isdigit() else None


# ------------------------------------------------------------------ the two zones

def _read_form(rows: list[list[str]]) -> tuple[str | None, str | None, list[dict]]:
    """The labelled part above the item table: date, place, and every party."""
    date: str | None = None
    place: str | None = None
    parties: list[dict] = []

    for cells in rows:
        joined = " | ".join(cells)
        if date is None:
            found = _ISO_DATE.search(joined)
            if found:
                date = found.group(1)

        for i, cell in enumerate(cells):
            if place is None and _PLACE.search(cell):
                place = _value_after(cells, i)
            party = _PARTY.match(cell)
            # A party row is a LABEL plus a code column. The bare `Bên A` in the
            # signature block has neither, and this is the second thing (after the
            # zone split) keeping it out of the cast.
            if party and (cell.rstrip().endswith(":") or _CODE.search(joined)):
                code = next(
                    (_value_after(cells, j) for j, c in enumerate(cells)
                     if _CODE.search(c)),
                    None,
                )
                parties.append({
                    "label": party.group(1).upper(),
                    "name": _value_after(cells, i),
                    "code": code,
                    "dept": None,
                    "position": None,
                })

        # Dept / Chức vụ sit on their own row, under the party they describe.
        if parties and not _PARTY.match(cells[0] if cells else ""):
            for i, cell in enumerate(cells):
                if _DEPT.search(cell) and parties[-1]["dept"] is None:
                    parties[-1]["dept"] = _value_after(cells, i)
                elif _POSITION.search(cell) and parties[-1]["position"] is None:
                    parties[-1]["position"] = _value_after(cells, i)

    return date, place, parties


def _read_items(rows: list[list[str]], columns: dict[str, int]) -> tuple[list[dict], int]:
    """The numbered rows under the header. Returns (items, numbered rows seen).

    The two numbers are compared by `_consistent`: they differ exactly when a row
    was numbered but yielded nothing usable, which is the case this module must
    decline rather than paper over.
    """
    items: list[dict] = []
    numbered = 0
    for cells in rows:
        def col(field: str) -> str | None:
            i = columns.get(field)
            if i is None or i >= len(cells):
                return None
            return cells[i].strip() or None

        no = _int(col("no"))
        if no is None:
            # The closing sentence and the signature block are not numbered, so
            # this is also where the table ends.
            continue
        numbered += 1
        serial = col("serial")
        if not serial:
            continue
        items.append({
            "no": no,
            "item": col("item"),
            "quantity": _int(col("quantity")) or 1,
            "detail": col("detail"),
            "serial": serial,
            "note": col("note"),
        })
    return items, numbered


# --------------------------------------------------------------- the spec split

# `Chi tiết` is one sentence holding every spec: "HP Laptop core i3 ram 8gb SSD
# 256gb". Splitting it is what the model was being asked for on top of locating
# fields, and it was ~40% of the tokens it generated per row.
#
# Every pattern captures a span of the detail text and the span is returned
# verbatim, never normalised — `verify_parsed` requires each part to occur in the
# source, and a "tidied" value would be thrown out as invented.
_BRANDS = (
    "hp", "dell", "asus", "lenovo", "acer", "msi", "apple", "macbook", "samsung",
    "lg", "toshiba", "fujitsu", "sony", "vaio", "gigabyte", "razer", "huawei",
    "xiaomi", "canon", "epson", "brother", "logitech", "viewsonic", "aoc", "philips",
)
_TYPES = (
    "laptop", "notebook", "desktop", "pc", "all in one", "aio", "workstation",
    "monitor", "màn hình", "man hinh", "printer", "máy in", "may in", "scanner",
    "keyboard", "bàn phím", "ban phim", "mouse", "chuột", "chuot", "dock",
    "tablet", "ipad", "phone", "điện thoại", "dien thoai", "server", "switch",
)
_CPU = re.compile(
    r"\b(?:core\s*ultra\s*\d+|core\s*i[3579](?:\s*ultra)?|i[3579][\s-]\w+"
    r"|ryzen\s*\d+|celeron|pentium|athlon|xeon|snapdragon|apple\s*m\d+|\bm[123]\b)",
    re.I,
)
_RAM = re.compile(r"\bram\s*(\d+\s*(?:gb|mb|tb))", re.I)
# Two spellings, and the order they are tried in is the whole point. "ram 8gb SSD
# 256gb" contains BOTH "SSD 256gb" and — one word earlier — "8gb SSD", so a single
# alternation returns the RAM size welded to the word SSD. The disk-word-first form
# is unambiguous, so it is asked first; the reversed form is only consulted when
# that finds nothing, and then never over the cell the RAM already claimed.
_STORAGE = re.compile(r"\b(?:ssd|hdd|nvme|emmc|sata)\s*\d+\s*(?:gb|tb)", re.I)
_STORAGE_REVERSED = re.compile(r"\b\d+\s*(?:gb|tb)\s*(?:ssd|hdd|nvme|emmc)", re.I)


def _first_word(detail: str, words: tuple[str, ...]) -> str | None:
    """The earliest of `words` occurring in `detail`, returned as the detail spells
    it. Longest-first at a given position so "all in one" beats nothing and
    "notebook" is not clipped to "note"."""
    low = detail.lower()
    best: tuple[int, int] | None = None
    for word in words:
        at = low.find(word)
        if at == -1:
            continue
        # Word-ish boundary, so "pc" doesn't match inside "hpcompaq".
        before_ok = at == 0 or not low[at - 1].isalnum()
        end = at + len(word)
        after_ok = end == len(low) or not low[end].isalnum()
        if not (before_ok and after_ok):
            continue
        if best is None or at < best[0] or (at == best[0] and len(word) > best[1] - best[0]):
            best = (at, end)
    return detail[best[0]:best[1]] if best else None


def split_device(detail: str | None, item: str | None = None) -> dict:
    """`Chi tiết` → the device columns a handover record can fill.

    `item` (the `Nội dung` cell) supplies `name`, which is what that column is: a
    human's name for the machine, not a spec.
    """
    fields: dict[str, str | None] = {
        "type": None, "brand": None, "cpu": None, "ram": None,
        "storage": None, "name": item or None,
    }
    if not detail:
        return fields
    fields["type"] = _first_word(detail, _TYPES)
    fields["brand"] = _first_word(detail, _BRANDS)
    cpu = _CPU.search(detail)
    if cpu:
        fields["cpu"] = cpu.group(0).strip()

    ram = _RAM.search(detail)
    if ram:
        # The captured group, not the whole match: the column holds "8gb", and the
        # word "ram" belongs to the sentence, not to the value.
        fields["ram"] = ram.group(1).strip()

    disk = _STORAGE.search(detail)
    if disk is None:
        # Only now, and only outside the span the RAM size occupies.
        disk = next(
            (m for m in _STORAGE_REVERSED.finditer(detail)
             if not (ram and m.start() < ram.end(1) and ram.start(1) < m.end())),
            None,
        )
    if disk:
        fields["storage"] = disk.group(0).strip()
    return fields


# ------------------------------------------------------------------- the entry

def count_item_rows(source_text: str) -> int:
    """How many numbered rows the item table has, whoever ends up reading it.

    This is the honest denominator for a progress bar: it is known before the read
    starts, it costs nothing, and it is right even when the model does the reading.
    Returns 0 when the table cannot be located at all.
    """
    rows = [c for c in (_cells(line) for line in (source_text or "").splitlines()) if c]
    for i, cells in enumerate(rows):
        if _is_header(cells):
            columns = _column_map(cells)
            if "no" not in columns:
                return 0
            return _read_items(rows[i + 1:], columns)[1]
    return 0


def _consistent(items: list[dict], numbered: int, parties: list[dict]) -> bool:
    """Is this parse whole enough to be trusted instead of the model's?

    Every numbered row has to have produced an item, because a row this module
    could not read is a row it does not know it is missing. Two parties with codes
    is the other floor — a record is at least two parties by definition, and one
    party means the labels were not really found.
    """
    if numbered == 0 or len(items) != numbered:
        return False
    return sum(1 for p in parties if p.get("code")) >= 2


def read_sheet(source_text: str) -> dict | None:
    """Read a flattened handover record into the shape `verify_parsed` expects, or
    None when this file is not one this parser can claim.

    None is not a failure — it is the handoff to `llm.read_handover_minutes`, which
    is what a scanned or off-template record needs.
    """
    rows = [c for c in (_cells(line) for line in (source_text or "").splitlines()) if c]
    header_at = next((i for i, cells in enumerate(rows) if _is_header(cells)), None)
    if header_at is None:
        return None
    columns = _column_map(rows[header_at])
    if "serial" not in columns or "no" not in columns:
        return None

    date, place, parties = _read_form(rows[:header_at])
    items, numbered = _read_items(rows[header_at + 1:], columns)
    if not _consistent(items, numbered, parties):
        return None

    for item in items:
        item["device"] = split_device(item.get("detail"), item.get("item"))
    return {
        "handover_date": date,
        "place": place,
        "parties": parties,
        "items": items,
    }
