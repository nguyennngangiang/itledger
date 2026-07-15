CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE TABLE users (
    employee_code VARCHAR(100) PRIMARY KEY,
    name VARCHAR(100),
    team VARCHAR(100)
);

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

CREATE TABLE user_devices (
    user_id VARCHAR(100) REFERENCES users(employee_code),
    device_id VARCHAR(100) REFERENCES devices(serial_number),
    PRIMARY KEY (user_id, device_id)
);

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
