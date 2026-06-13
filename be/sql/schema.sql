CREATE TABLE teams (
    team_id VARCHAR(100) PRIMARY KEY,
    team_name VARCHAR(200),
    division VARCHAR(200)
);

CREATE TABLE users (
    employee_code VARCHAR(100) PRIMARY KEY,
    name VARCHAR(100),
    team VARCHAR(100) REFERENCES teams(team_id)
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
    user_id VARCHAR(100) REFERENCES users(employee_code)
);

CREATE TABLE handovers (
    handover_id VARCHAR(100) PRIMARY KEY,
    handover_date DATE,
    device_id VARCHAR(100) REFERENCES devices(serial_number),
    from_user_id VARCHAR(100) REFERENCES users(employee_code),
    to_user_id VARCHAR(100) REFERENCES users(employee_code),
    reason VARCHAR(100)
);

CREATE TABLE maintenance (
    maintenance_id VARCHAR(100) PRIMARY KEY,
    maintenance_date DATE,
    device_id VARCHAR(100) REFERENCES devices(serial_number),
    team VARCHAR(100) REFERENCES teams(team_id),
    part VARCHAR(200),
    reason VARCHAR(500),
    solution VARCHAR(500),
    result VARCHAR(500),
    cost_vnd DECIMAL(12, 2),
    remarks VARCHAR(500)
);

CREATE TABLE user_devices (
    user_id VARCHAR(100) REFERENCES users(employee_code),
    device_id VARCHAR(100) REFERENCES devices(serial_number),
    PRIMARY KEY (user_id, device_id)
);
