CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE TABLE users (
    employee_code VARCHAR(100) PRIMARY KEY,
    name VARCHAR(100),
    team VARCHAR(100),
    -- Employment status. Distinct from `deleted_at`: someone who has left the
    -- company is 'retired' but still a real person — their handover history has
    -- to keep reading, and the report of who still holds a device depends on
    -- them staying visible. `deleted_at` is for rows entered by mistake.
    -- Also applied at app startup for already-running databases (see
    -- be/repositories/user.py USER_MIGRATIONS_DDL).
    status VARCHAR(16) NOT NULL DEFAULT 'active',
    deleted_at TIMESTAMP
);

-- The ghost account that owns everything nobody is using. Structural, not sample
-- data: owner_for_status() (be/repositories/device.py) writes this code into
-- devices.user_id for any maintaining/on_del device, so without the row those
-- writes fail the FK. It used to be created only by be/seed.py, which left an
-- unseeded volume with a device API that rejected those statuses. Also applied
-- at startup for already-running databases (be/repositories/user.py GHOST_DDL).
INSERT INTO users (employee_code, name, team)
VALUES ('IT-STORE', 'IT Store', 'IT')
ON CONFLICT (employee_code) DO NOTHING;

CREATE TABLE devices (
    serial_number VARCHAR(100) PRIMARY KEY,
    barcode VARCHAR(100) UNIQUE,
    type VARCHAR(100),
    brand VARCHAR(100),
    cpu VARCHAR(100),
    ram VARCHAR(100),
    storage VARCHAR(100),
    os VARCHAR(100),
    msoffice VARCHAR(100),
    buy_date DATE,
    name VARCHAR(100),
    user_id VARCHAR(100) REFERENCES users(employee_code),
    status VARCHAR(100),
    deleted_at TIMESTAMP
);

CREATE TABLE handovers (
    handover_id VARCHAR(100) PRIMARY KEY,
    handover_date DATE,
    device_id VARCHAR(100) REFERENCES devices(serial_number),
    from_user_id VARCHAR(100) REFERENCES users(employee_code),
    to_user_id VARCHAR(100) REFERENCES users(employee_code),
    reason VARCHAR(100),
    deleted_at TIMESTAMP
);

CREATE TABLE maintenance (
    maintenance_id VARCHAR(100) PRIMARY KEY,
    maintenance_date DATE,
    device_id VARCHAR(100) REFERENCES devices(serial_number),
    team VARCHAR(100),
    part VARCHAR(200),
    reason VARCHAR(500),
    solution VARCHAR(500),
    result VARCHAR(500),
    cost_vnd DECIMAL(12, 2),
    remarks VARCHAR(500),
    deleted_at TIMESTAMP
);

-- There is no user_devices join table. A device has exactly one owner and
-- devices.user_id is where it lives; the join table mirrored that, was never
-- read by anything, and drifted (166 rows, 131 agreeing). Retired by
-- sql/migrations/0001_retire_user_devices.sql — don't reintroduce it.

-- Smart-search relevance feedback: each row marks a result correct (label=1) or
-- not (label=0) for a query on a given resource (devices/maintenance/handovers).
-- Steers the LLM reranker per-project as few-shot anchors (the shared model is
-- never trained). No FK so labels survive a purge. Also created at app startup
-- (see main.py) for already-running databases.
CREATE TABLE IF NOT EXISTS search_feedback (
    id BIGSERIAL PRIMARY KEY,
    resource VARCHAR(32) NOT NULL DEFAULT 'devices',
    item_id VARCHAR(100),
    query TEXT NOT NULL,
    document TEXT,
    score DOUBLE PRECISION,
    label SMALLINT NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_search_feedback_query
    ON search_feedback (resource, lower(query));

-- Handover-minutes importer: one row per disagreement a human still has to rule
-- on (person under another employee code, field that contradicts the workbook,
-- device created with half its spec, handover that looks already recorded). The
-- importer never silently picks a side. Backs the Notifications screen + badge.
-- Also created at app startup (see main.py) for already-running databases.
CREATE TABLE IF NOT EXISTS import_issues (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMP NOT NULL DEFAULT now(),
    source_file VARCHAR(255),
    kind VARCHAR(40) NOT NULL,
    resource VARCHAR(16) NOT NULL DEFAULT 'handovers',
    item_id VARCHAR(100),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status VARCHAR(16) NOT NULL DEFAULT 'open',
    resolved_at TIMESTAMP,
    resolution JSONB
);
CREATE INDEX IF NOT EXISTS idx_import_issues_open
    ON import_issues (status, created_at DESC);
