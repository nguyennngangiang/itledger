-- Retire user_devices.
--
-- The table is a many-to-many join over a relationship that is single-valued:
-- a device has exactly one owner, and devices.user_id is where it lives. Nothing
-- in the codebase has ever SELECTed from user_devices — it was written by
-- be/seed.py and be/import_real.py and read by no one — so the two copies drifted
-- freely. On the live ledger 166 rows existed and only 131 agreed with
-- devices.user_id. It also added a third FK to every device, so it stood in the
-- way of purging a device that the ledger itself had no history for.
--
-- Renamed rather than dropped. Nothing here touches a row: all 166 stay readable
-- as user_devices_legacy, and the reverse is a rename back plus re-adding the two
-- constraints. DROP TABLE comes later, once it has sat unreferenced for a while.
--
-- Safe to re-run: every statement is guarded, so applying this by hand and then
-- letting be/migrations.py apply it again is a no-op.
--
-- Apply:
--   docker exec -i itledger-db-1 psql -U postgres -d itledger \
--     < be/sql/migrations/0001_retire_user_devices.sql

BEGIN;

-- Dropping a constraint needs ACCESS EXCLUSIVE on user_devices and briefly on
-- devices/users. At this size that is a sub-millisecond catalog update, but the
-- timeout is what makes it genuinely safe: if anything is holding a conflicting
-- lock the migration aborts instead of queueing in front of live API traffic.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE IF EXISTS user_devices DROP CONSTRAINT IF EXISTS user_devices_device_id_fkey;
ALTER TABLE IF EXISTS user_devices DROP CONSTRAINT IF EXISTS user_devices_user_id_fkey;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public'
                                         AND tablename = 'user_devices') THEN
        ALTER TABLE user_devices RENAME TO user_devices_legacy;
    END IF;
END
$$;

COMMIT;
