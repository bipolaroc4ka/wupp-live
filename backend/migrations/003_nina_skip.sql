-- Кэш NINA: предупреждения, которые уже проверены и не относятся к Вупперталю/NRW.
-- Без него каждые 5 минут пришлось бы заново запрашивать контур каждого предупреждения по всей Германии
-- (лимит Workers Free — 50 подзапросов за запуск).
-- Применение: npx wrangler d1 execute wuppertal-live --remote --file=./migrations/003_nina_skip.sql
CREATE TABLE IF NOT EXISTS nina_skip (
  id      TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  reason  TEXT,
  ts      TEXT NOT NULL
);
