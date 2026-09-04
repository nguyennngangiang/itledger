#!/usr/bin/env bash
#
# Restore a backup directory produced by deploy/vps/dump-db.sh into the VPS's
# Postgres container, then prove it landed by re-counting every table and
# comparing against the manifest.
#
#   bash deploy/vps/restore-db.sh backups/itledger-20260904-1830
#
# Override the target with env vars if the container is named differently:
#   CONTAINER=itledger-db-1  DB=itledger  DB_USER=postgres
#
# THREE THINGS THAT WILL BITE YOU, in the order you will hit them:
#
# 1. The container creates the tables for you. be/docker-compose.yml mounts
#    be/sql/schema.sql into /docker-entrypoint-initdb.d/, so a fresh volume comes
#    up with the full (empty) schema already in place. That is why the restore
#    below passes --clean --if-exists: without it pg_restore hits "relation
#    already exists" on every table, keeps going, and leaves you with a database
#    that looks restored and holds nothing. Run this AFTER the container is up
#    and accepting connections, never against a half-initialised one.
#
# 2. CREATE EXTENSION unaccent needs superuser. Restoring as the `postgres` role
#    of a stock postgres:16 container is fine. On a managed Postgres with a
#    restricted role, create the extension by hand first and expect a harmless
#    error line for it during the restore.
#
# 3. The dump is a -Fc archive, readable only by a pg_restore of the same major
#    version or newer. It was taken on 16.14, so the VPS wants Postgres 16 or 17.
#    If it is older, skip this script and load itledger.sql with psql instead.
set -euo pipefail

CONTAINER="${CONTAINER:-itledger-db-1}"
DB="${DB:-itledger}"
DB_USER="${DB_USER:-postgres}"

BACKUP="${1:-}"
[ -n "$BACKUP" ] || { echo "usage: $0 <backup-dir>" >&2; exit 1; }
[ -d "$BACKUP" ] || { echo "ERROR: $BACKUP is not a directory" >&2; exit 1; }

ARCHIVE="$BACKUP/itledger.dump"
MANIFEST="$BACKUP/manifest.txt"
for f in "$ARCHIVE" "$MANIFEST"; do
    [ -f "$f" ] || { echo "ERROR: $f missing" >&2; exit 1; }
done

echo "==> verifying checksums"
if [ -f "$BACKUP/SHA256SUMS" ]; then
    ( cd "$BACKUP" && sha256sum -c SHA256SUMS )
else
    echo "    no SHA256SUMS in the backup — skipping"
fi

echo "==> waiting for $CONTAINER to accept connections"
for _ in $(seq 1 60); do
    docker exec "$CONTAINER" pg_isready -U "$DB_USER" -d "$DB" >/dev/null 2>&1 && break
    sleep 1
done
docker exec "$CONTAINER" pg_isready -U "$DB_USER" -d "$DB" >/dev/null \
    || { echo "ERROR: $CONTAINER never became ready" >&2; exit 1; }

echo "==> restoring"
docker cp "$ARCHIVE" "$CONTAINER:/tmp/itledger.dump"
# Not `set -e`-fatal: --clean emits DROP errors for objects a fresh database has
# never had, and the extension line fails on a non-superuser role. Neither is a
# reason to stop — the row-count check below is what actually decides.
docker exec "$CONTAINER" pg_restore \
    --clean --if-exists --no-owner --no-privileges \
    -U "$DB_USER" -d "$DB" /tmp/itledger.dump || true
docker exec "$CONTAINER" rm -f /tmp/itledger.dump

echo "==> checking the row counts against the manifest"
fail=0
while IFS='=' read -r key expected; do
    case "$key" in rows.*) ;; *) continue ;; esac
    table="${key#rows.}"
    actual="$(docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB" -t -A \
        -c "SELECT count(*) FROM $table")"
    if [ "$actual" = "$expected" ]; then
        printf '    %-16s %6s  ok\n' "$table" "$actual"
    else
        printf '    %-16s %6s  MISMATCH (manifest says %s)\n' "$table" "$actual" "$expected"
        fail=1
    fi
done < "$MANIFEST"

if [ "$fail" -ne 0 ]; then
    echo
    echo "RESTORE INCOMPLETE — the counts above do not match the dump." >&2
    echo "Do not point the app at this database. See the three notes at the top." >&2
    exit 1
fi

echo
echo "Restore verified against $MANIFEST."
echo "Next: start the API and check /healthz returns {\"status\":\"ok\",\"db\":\"up\"}."
