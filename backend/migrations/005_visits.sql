-- Уникальные посетители по дням. Хранится только усечённый хэш, IP и User-Agent не сохраняются.
CREATE TABLE IF NOT EXISTS visits (
  day      TEXT NOT NULL,
  vid      TEXT NOT NULL,
  platform TEXT NOT NULL,
  lang     TEXT,
  PRIMARY KEY (day, vid)
);
