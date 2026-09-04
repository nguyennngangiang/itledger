#!/usr/bin/env bash
#
# Extract the staff list out of employee.dump into employees_import.json.
#
#   wsl -d Ubuntu-24.04 -u root -- bash /mnt/d/itledger/_extract_employees.sh
#
# Why a throwaway container: employee.dump is a pg_dump -Fc archive (format
# v1.16) taken from the yic_operation_staging HR database on PostgreSQL 17.
# Nothing on this host can read it — WSL has no postgres-client and the
# itledger-db-1 container ships pg_restore 16.14, which rejects a v1.16 header.
# So we spin a disposable postgres:17, restore into it, run one SQL join, and
# throw it away. That beats hand-parsing the archive's compressed COPY blocks.
#
# The container publishes no ports and mounts no volumes: it never touches the
# itledger database. This script only ever READS employee.dump and WRITES the
# JSON — it does not go near the app's data.
#
# Only the columns the import actually needs come out. employees also holds
# email, phone, dob and university; there is no reason for that to leave the
# dump, so it is never selected.
#
# Mirrors _build_import.mjs: extraction is a separate step from writing to the
# database (that half is be/import_employees.py).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DUMP="$ROOT/employee.dump"
OUT="$ROOT/employees_import.json"
CONTAINER="emp-extract"
IMAGE="postgres:17"
DB="hr_extract"

[ -f "$DUMP" ] || { echo "ERROR: $DUMP not found" >&2; exit 1; }

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup   # in case a previous run died before its trap fired

echo "==> starting disposable $IMAGE (no ports, no volumes)"
docker run -d --rm --name "$CONTAINER" \
    -e POSTGRES_PASSWORD=extract \
    -e POSTGRES_DB="$DB" \
    "$IMAGE" >/dev/null

echo -n "==> waiting for it to accept connections"
for _ in $(seq 1 60); do
    if docker exec "$CONTAINER" pg_isready -U postgres -d "$DB" >/dev/null 2>&1; then
        echo " ok"
        break
    fi
    echo -n "."
    sleep 1
done
docker exec "$CONTAINER" pg_isready -U postgres -d "$DB" >/dev/null

echo "==> restoring the dump"
docker cp "$DUMP" "$CONTAINER:/tmp/employee.dump"
# --no-owner/--no-privileges: the dump references the yic_app role, which does
# not exist here and is irrelevant to reading the data.
# Errors are tolerated: we only need four tables, and the archive also carries
# extensions/roles this scratch server has no use for.
docker exec "$CONTAINER" pg_restore \
    --no-owner --no-privileges --no-comments \
    -U postgres -d "$DB" /tmp/employee.dump >/dev/null 2>&1 || true

echo "==> checking the tables arrived"
docker exec "$CONTAINER" psql -U postgres -d "$DB" -t -A -c \
    "SELECT 'employees=' || count(*) FROM public.employees" \
    || { echo "ERROR: employees table did not restore" >&2; exit 1; }

echo "==> extracting"
# One row per employee, with both candidate team sources so the import step can
# be told which to use (departments.name vs divisions.name) after comparing
# them against the teams we already have.
docker exec "$CONTAINER" psql -U postgres -d "$DB" -t -A -c "
SELECT coalesce(json_agg(row_to_json(t) ORDER BY t.staff_code), '[]'::json)
FROM (
    SELECT
        btrim(e.\"staffCode\")        AS staff_code,
        nullif(btrim(e.name), '')     AS name,
        nullif(btrim(d.name), '')     AS department,
        nullif(btrim(v.name), '')     AS division,
        nullif(btrim(v.code), '')     AS division_code,
        nullif(btrim(s.name), '')     AS status,
        e.\"isActive\"                AS is_active,
        e.\"lastWorkingDay\"          AS last_working_day
    FROM public.employees e
    LEFT JOIN public.departments       d ON d.id = e.\"departmentId\"
    LEFT JOIN public.divisions         v ON v.id = e.\"divisionId\"
    LEFT JOIN public.employee_statuses s ON s.id = e.\"statusId\"
    WHERE btrim(coalesce(e.\"staffCode\", '')) <> ''
) t;
" > "$OUT"

echo "==> wrote $OUT ($(wc -c < "$OUT") bytes)"
echo "==> done; container removed on exit"
