

CREATE TABLE IF NOT EXISTS events (
  id               TEXT PRIMARY KEY,               
  city_id          TEXT NOT NULL DEFAULT 'wuppertal',
  source           TEXT NOT NULL,                   
  source_event_id  TEXT NOT NULL,                  
  scope            TEXT,                            
  publisher        TEXT,                            
  title            TEXT NOT NULL,
  description      TEXT,
  category         TEXT NOT NULL,
  source_url       TEXT,
  latitude         REAL,                            
  longitude        REAL,
  geo_precision    TEXT NOT NULL DEFAULT 'none'
                   CHECK (geo_precision IN ('source','street','district','city','none')),
  location_name    TEXT,
  district         TEXT,
  event_time       TEXT,                            
  time_precision   TEXT NOT NULL DEFAULT 'unknown'
                   CHECK (time_precision IN ('minute','day','unknown')),
  published_at     TEXT,                           
  received_at      TEXT NOT NULL,                   
  updated_at       TEXT NOT NULL,                   
  status           TEXT NOT NULL CHECK (status IN ('LIVE','ACTIVE','RECENT','EXPIRED','RESOLVED')),
  status_reason    TEXT,
  confidence       REAL NOT NULL DEFAULT 0.5,
  is_verified      INTEGER NOT NULL DEFAULT 0,      
  expires_at       TEXT,
  severity         TEXT,
  content_hash     TEXT NOT NULL,
  geocode_attempts INTEGER NOT NULL DEFAULT 0,
  miss_count       INTEGER NOT NULL DEFAULT 0       
);

CREATE INDEX IF NOT EXISTS idx_events_city_status ON events (city_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_events_source      ON events (source, status);
CREATE INDEX IF NOT EXISTS idx_events_geo         ON events (latitude, longitude);

CREATE TABLE IF NOT EXISTS sources (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  interval_sec    INTEGER NOT NULL,
  last_run_at     TEXT,
  last_success_at TEXT,
  last_error      TEXT,
  last_error_at   TEXT,
  runs            INTEGER NOT NULL DEFAULT 0,
  errors          INTEGER NOT NULL DEFAULT 0,
  last_fetched    INTEGER NOT NULL DEFAULT 0,       
  last_changes    INTEGER NOT NULL DEFAULT 0        
);

CREATE TABLE IF NOT EXISTS geocode_cache (
  key          TEXT PRIMARY KEY,
  found        INTEGER NOT NULL,
  lat          REAL,
  lon          REAL,
  precision    TEXT,
  district     TEXT,
  display_name TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS error_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL,
  source  TEXT,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_error_log_ts ON error_log (ts);


CREATE TABLE IF NOT EXISTS suppressed (
  id      TEXT PRIMARY KEY,
  ts      TEXT NOT NULL
);
