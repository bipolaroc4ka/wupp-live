-- Wuppertal Live — схема D1 (SQLite)
-- Применение: npx wrangler d1 execute wuppertal-live --remote --file=./schema.sql
-- Все времена хранятся как ISO-8601 UTC строки (toISOString), поэтому сравниваются как текст.

CREATE TABLE IF NOT EXISTS events (
  id               TEXT PRIMARY KEY,                -- "<source>:<sha256-16>"
  city_id          TEXT NOT NULL DEFAULT 'wuppertal',
  source           TEXT NOT NULL,                   -- id источника: autobahn | nina | presseportal
  source_event_id  TEXT NOT NULL,                   -- идентификатор у источника
  scope            TEXT,                            -- часть источника (напр. "A46/closure"), нужна для безопасного завершения событий
  publisher        TEXT,                            -- кто опубликовал (напр. "Feuerwehr Wuppertal")
  title            TEXT NOT NULL,
  description      TEXT,
  category         TEXT NOT NULL,
  source_url       TEXT,
  latitude         REAL,                            -- NULL, если место не обосновано данными
  longitude        REAL,
  geo_precision    TEXT NOT NULL DEFAULT 'none'
                   CHECK (geo_precision IN ('source','street','district','city','none')),
  location_name    TEXT,
  district         TEXT,
  event_time       TEXT,                            -- время ПРОИСШЕСТВИЯ (NULL = неизвестно)
  time_precision   TEXT NOT NULL DEFAULT 'unknown'
                   CHECK (time_precision IN ('minute','day','unknown')),
  published_at     TEXT,                            -- время публикации источником
  received_at      TEXT NOT NULL,                   -- когда мы впервые получили запись
  updated_at       TEXT NOT NULL,                   -- последнее изменение записи у нас
  status           TEXT NOT NULL CHECK (status IN ('LIVE','ACTIVE','RECENT','EXPIRED','RESOLVED')),
  status_reason    TEXT,
  confidence       REAL NOT NULL DEFAULT 0.5,       -- 0..1: надёжность источника и места
  is_verified      INTEGER NOT NULL DEFAULT 0,      -- 1 = сообщение официального источника
  expires_at       TEXT,
  severity         TEXT,
  content_hash     TEXT NOT NULL,
  geocode_attempts INTEGER NOT NULL DEFAULT 0,
  miss_count       INTEGER NOT NULL DEFAULT 0       -- сколько раз подряд записи не было в ленте
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
  last_fetched    INTEGER NOT NULL DEFAULT 0,       -- сколько записей вернул источник в последнем запуске
  last_changes    INTEGER NOT NULL DEFAULT 0        -- сколько записей изменилось в последнем запуске
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

-- Записи, удалённые администратором: источник не сможет добавить их снова.
CREATE TABLE IF NOT EXISTS suppressed (
  id      TEXT PRIMARY KEY,
  ts      TEXT NOT NULL
);

-- Машинный перевод текстов событий (DE -> RU); оригинал всегда остаётся в events.
-- Если у вас уже есть таблица translations со старыми колонками, примените migrations/002_translations.sql.
CREATE TABLE IF NOT EXISTS translations (
  id              TEXT PRIMARY KEY,
  event_id        TEXT NOT NULL,
  source_lang     TEXT NOT NULL DEFAULT 'de',
  target_lang     TEXT NOT NULL DEFAULT 'ru',
  text_type       TEXT NOT NULL CHECK (text_type IN ('title','description')),
  original_text   TEXT,
  translated_text TEXT,
  model           TEXT,
  src_hash        TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_translations ON translations (event_id, target_lang, text_type);

-- Кэш NINA: уже проверенные предупреждения вне Вупперталя/NRW (см. migrations/003_nina_skip.sql).
CREATE TABLE IF NOT EXISTS nina_skip (
  id      TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  reason  TEXT,
  ts      TEXT NOT NULL
);
