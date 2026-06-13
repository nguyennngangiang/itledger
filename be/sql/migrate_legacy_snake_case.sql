-- Rename remaining legacy camelCase columns to match sql/schema.sql.
-- Safe to re-run only via migrate_legacy_schema.py (checks column names first).

-- maintenance
ALTER TABLE maintenance RENAME COLUMN maintenanceid TO maintenance_id;
ALTER TABLE maintenance RENAME COLUMN maintenancedate TO maintenance_date;
ALTER TABLE maintenance RENAME COLUMN deviceid TO device_id;
ALTER TABLE maintenance RENAME COLUMN costvnd TO cost_vnd;

-- handovers
ALTER TABLE handovers RENAME COLUMN handoverid TO handover_id;
ALTER TABLE handovers RENAME COLUMN handoverdate TO handover_date;
ALTER TABLE handovers RENAME COLUMN deviceid TO device_id;

-- user_devices
ALTER TABLE user_devices RENAME COLUMN userid TO user_id;
ALTER TABLE user_devices RENAME COLUMN deviceid TO device_id;

-- teams (no-op if already migrated)
ALTER TABLE teams RENAME COLUMN teamid TO team_id;
ALTER TABLE teams RENAME COLUMN teamname TO team_name;

-- devices (no-op if already migrated)
ALTER TABLE devices RENAME COLUMN buydate TO buy_date;
ALTER TABLE devices RENAME COLUMN userid TO user_id;
