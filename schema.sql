-- filepath: schema.sql
DROP TABLE IF EXISTS request_logs;
CREATE TABLE request_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    latitude REAL,
    longitude REAL,
    radius REAL,
    request_pretty_print INTEGER, -- 0 for false, 1 for true
    response_type TEXT, -- e.g., 'application/json', 'text/plain'
    response_body TEXT,
    response_success INTEGER -- 0 for false, 1 for true
);

ALTER TABLE request_logs ADD COLUMN raw_flight_data TEXT;