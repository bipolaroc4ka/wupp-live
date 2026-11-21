-- Таблица машинных переводов (DE -> RU). Оригиналы остаются в events.
-- Применение: npx wrangler d1 execute wuppertal-live --remote --file=./migrations/002_translations.sql
--
-- ВНИМАНИЕ: первая строка удаляет старую таблицу translations, если она есть (в более ранней версии проекта у неё были другие колонки).
-- Это только кэш машинных переводов: он пересоздаётся сам при следующих запусках cron (по 6 событий за 10 минут).
-- Данные событий не затрагиваются.
DROP TABLE IF EXISTS translations;

CREATE TABLE translations (
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
CREATE UNIQUE INDEX ux_translations ON translations (event_id, target_lang, text_type);
