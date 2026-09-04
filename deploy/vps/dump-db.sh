#!/usr/bin/env bash
#
# Package the live IT Ledger database into a directory that can be carried to the
# Linux VPS and restored there by deploy/vps/restore-db.sh.
#
#   wsl -d Ubuntu-24.04 -u root -- bash /mnt/d/itledger/deploy/vps/dump-db.sh
#
# Run it from INSIDE the WSL distro, not from Windows: DOCKER_HOST on this host
# points at a different engine than the Ubuntu-24.04 daemon that runs these
# containers (see deploy/README.md).
#
# This script only READS. pg_dump takes no write lock, so it is safe to run while
# people are using the app — but the dump is a point-in-time snapshot, so take it
# when the ledger is quiet if you want the VPS to match exactly.
#
# Two dumps come out on purpose:
#
#   itledger.dump  -- pg_dump -Fc. Compressed, restores selectively, and is what
#                     restore-db.sh uses.
#   itledger.sql   -- the plain-SQL twin. A -Fc archive can only be read by a
#                     pg_restore of the same major version or newer, so if the
#                     VPS ends up on a Postgres OLDER than 16 the archive is
#                     unreadable there and this file is the way in. It costs a
#                     few megabytes; not having it costs an evening.
#
# The output directory is under backups/, which .gitignore excludes — these files
# carry real employee names and codes and must never reach the repo.
set -euo pipefail

CONTAINER="itledger-db-1"
DB="itledger"
DB_USER="postgres"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M)"
OUT="$ROOT/backups/itledger-$STAMP"

docker inspect "$CONTAINER" >/dev/null 2>&1 \
    || { echo "ERROR: container $CONTAINER not found. Is the stack up?" >&2; exit 1; }

mkdir -p "$OUT"
echo "==> writing to $OUT"

# --no-owner/--no-privileges: the dump would otherwise reference the `postgres`
# role of THIS server. The VPS restores as whatever role it has; ownership here
# is meaningless there.
echo "==> pg_dump -Fc"
docker exec "$CONTAINER" pg_dump -Fc --no-owner --no-privileges \
    -U "$DB_USER" -d "$DB" > "$OUT/itledger.dump"

echo "==> pg_dump (plain SQL)"
docker exec "$CONTAINER" pg_dump --no-owner --no-privileges \
    -U "$DB_USER" -d "$DB" > "$OUT/itledger.sql"

# The manifest is what restore-db.sh checks against, so the row counts must be
# real counts and not pg_stat_user_tables estimates — those are stale until an
# ANALYZE runs and reported 1 device on a 334-device ledger.
echo "==> manifest"
{
    echo "taken_at=$(date -Is)"
    echo "source_host=$(hostname)"
    echo "git_commit=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
    echo "git_branch=$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
    docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB" -t -A -c "
        SELECT 'server_version=' || current_setting('server_version')"
    docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB" -t -A -c "
        SELECT 'database_size=' || pg_size_pretty(pg_database_size(current_database()))"
    docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB" -t -A -c "
        SELECT 'extension=' || extname FROM pg_extension ORDER BY extname"
    echo "# rows.<table>=<count> — restore-db.sh re-runs these and fails on a mismatch"
    docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB" -t -A -c "
        SELECT 'rows.users='          || (SELECT count(*) FROM users)
        UNION ALL SELECT 'rows.devices='       || (SELECT count(*) FROM devices)
        UNION ALL SELECT 'rows.handovers='     || (SELECT count(*) FROM handovers)
        UNION ALL SELECT 'rows.maintenance='   || (SELECT count(*) FROM maintenance)
        UNION ALL SELECT 'rows.import_issues=' || (SELECT count(*) FROM import_issues)
        UNION ALL SELECT 'rows.search_feedback=' || (SELECT count(*) FROM search_feedback)"
} > "$OUT/manifest.txt"

echo "==> checksums"
( cd "$OUT" && sha256sum itledger.dump itledger.sql > SHA256SUMS )

echo
cat "$OUT/manifest.txt"
echo
ls -lh "$OUT"
echo
echo "Done. Copy the whole directory to the VPS, then run deploy/vps/restore-db.sh there."
