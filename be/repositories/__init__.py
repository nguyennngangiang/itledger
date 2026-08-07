"""Data-access layer: all SQL and transactions live here, one module per resource.

Repositories take a pool/connection and return plain dicts; they raise the domain
errors in errors.py instead of leaking asyncpg exceptions to the routers.
"""
import asyncpg


async def distinct_values(
    pool: asyncpg.Pool, table: str, column: str, allowed: frozenset[str]
) -> list[str]:
    """Distinct non-blank values of one column — the source for form autocomplete.

    Both `table` and `column` are interpolated, so both must come from our own
    source: `table` is a literal at the call site and `column` is checked
    against that resource's allow-list. Anything else raises ValueError, which
    the router turns into a 400 (same contract as filter_devices).

    Only live rows count: suggesting a brand that exists solely in the trash
    would put deleted data back into circulation.

    Case variants are collapsed to the spelling used most often. The real data
    holds both "ASUS" and "Asus"; offering both as suggestions would just keep
    the split growing, so the majority spelling wins and the other disappears
    from the picker (existing rows are untouched).
    """
    if column not in allowed:
        raise ValueError(f"Unsupported field: {column}")
    rows = await pool.fetch(
        f"""SELECT v FROM (
                SELECT btrim({column}::text) AS v,
                       row_number() OVER (
                           PARTITION BY lower(btrim({column}::text))
                           ORDER BY count(*) DESC, btrim({column}::text)
                       ) AS rn
                FROM {table}
                WHERE {column} IS NOT NULL
                  AND btrim({column}::text) <> ''
                  AND deleted_at IS NULL
                GROUP BY btrim({column}::text)
            ) s
            WHERE rn = 1
            ORDER BY v"""
    )
    return [r["v"] for r in rows]


def owner_match(col: str, i: int) -> str:
    """SQL fragment: does the person referenced by `col` match placeholder $i?

    Rows store an owner as an employee_code FK; the person's *name* lives in
    `users`. So a search over a row's own columns can only ever match the code —
    typing "Quân" found nothing until this existed. Matches the code and the name.

    EXISTS, not JOIN, so the row count is untouched and `count(*)` totals stay
    right. unaccent() mirrors user.search() (and needs the extension created in
    sql/schema.sql) so "van" also finds "Vân".

    `col` is always a literal from our own source, never user input.
    """
    return (
        f"({col} ILIKE ${i} OR EXISTS ("
        f"SELECT 1 FROM users u WHERE u.employee_code = {col} "
        f"AND unaccent(u.name) ILIKE unaccent(${i})))"
    )


def device_owner_match(col: str, i: int) -> str:
    """owner_match() one hop further out, for rows that only reference a device.

    A maintenance row carries a device_id and the screen renders that device's
    owner, so the owner has to be searchable there too.
    """
    return (
        f"EXISTS (SELECT 1 FROM devices d JOIN users u ON u.employee_code = d.user_id "
        f"WHERE d.serial_number = {col} AND unaccent(u.name) ILIKE unaccent(${i}))"
    )
