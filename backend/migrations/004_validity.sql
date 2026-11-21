-- Начало и конец ДЕЙСТВИЯ предупреждения/меры (не время происшествия). Выполняется один раз.
ALTER TABLE events ADD COLUMN valid_from TEXT;
ALTER TABLE events ADD COLUMN valid_until TEXT;
ALTER TABLE events ADD COLUMN valid_from_precision TEXT;
ALTER TABLE events ADD COLUMN valid_until_precision TEXT;
