
// Wuppertal Live — машинный перевод событий DE → RU.
// Оригиналы всегда остаются в events.
// Названия улиц и мест не отправляются в Workers AI.
// Ошибка одного события не останавливает обработку остальных.

import { ISO, truncate } from './util.js';

const MODEL = '@cf/meta/m2m100-1.2b';
const CHUNK = 400;
const MAX_DESC = 1600;
const PER_RUN = 6;
const SCAN_LIMIT = 500;

// ------------------------------------------------------------
// ЗАЩИТА НАЗВАНИЙ УЛИЦ И МЕСТ
// ------------------------------------------------------------

// Латинские буквы используются для распознавания немецких названий.
// Кириллица после названия не мешает его обнаружению.
const NAME_CHARS = String.raw`[\p{Script=Latin}\p{M}0-9'’-]`;

const LEFT_BOUNDARY = String.raw`(?<![\p{Script=Latin}\p{N}])`;
const RIGHT_BOUNDARY = String.raw`(?![\p{Script=Latin}\p{N}])`;

const SUFFIX_JOINED =
  '(?:[Ss]traße|[Ss]trasse|[Ss]tr\\.|[Ww]eg|[Pp]latz|[Aa]llee|[Rr]ing|[Gg]asse|[Uu]fer|[Dd]amm|[Cc]haussee|[Ss]tieg|[Bb]rücke|[Bb]ruecke|[Pp]romenade|[Ww]all|[Hh]öfe|[Hh]oefe|[Mm]arkt)';

const SUFFIX_SEPARATE =
  '(?:Straße|Strasse|Str\\.|Weg|Platz|Allee|Ring|Gasse|Ufer|Damm|Markt|Brücke|Promenade)';

// Слова, с которых название обычно не начинается.
const NOT_A_NAME =
  '(?:Der|Die|Das|Den|Dem|Des|Ein|Eine|Einen|Einer|Auf|An|Am|Im|In|Zum|Zur|Bitte|Wegen|Sperrung|Vollsperrung)';

// «Hauptstraße», «Friedrich-Ebert-Straße», «Bahnhofstr.»
const PLACE_JOINED = new RegExp(
  String.raw`${LEFT_BOUNDARY}\p{Lu}${NAME_CHARS}*${SUFFIX_JOINED}${RIGHT_BOUNDARY}`,
  'gu'
);

// «Wuppertaler Straße», «Alter Markt», «Lichtscheider Str.»
const PLACE_SEPARATE = new RegExp(
  String.raw`${LEFT_BOUNDARY}(?!${NOT_A_NAME}[ \t])\p{Lu}${NAME_CHARS}*[ \t]+${SUFFIX_SEPARATE}${RIGHT_BOUNDARY}`,
  'gu'
);

// Названия, соединённые дефисами.
// «Wuppertal-Barmen», «Wuppertal-Ronsdorf»,
// «Max-Horkheimer-Straße», «W-Wichlinghausen».
const TOKEN = String.raw`\p{Lu}[\p{Script=Latin}\p{M}'’]*`;
const HYPHENATED = String.raw`${TOKEN}(?:-${TOKEN})*`;

const PLACE_HYPHEN = new RegExp(
  String.raw`${LEFT_BOUNDARY}${TOKEN}(?:-${TOKEN})+${RIGHT_BOUNDARY}`,
  'gu'
);

// Географические названия после вводных слов:
// «Richtung Köln», «AS Barmen», «Dreieck Nord».
const LEAD_WORDS =
  '(?:Richtung|zwischen|Anschlussstelle|Autobahnkreuz|Autobahndreieck|Dreieck|Kreuz|AS|AK|AD)';

const PLACE_AFTER_LEAD = new RegExp(
  String.raw`(?<=${LEAD_WORDS}[ \t]+)${HYPHENATED}${RIGHT_BOUNDARY}`,
  'gu'
);

const PLACE_AFTER_BETWEEN = new RegExp(
  String.raw`(?<=zwischen[ \t]+${HYPHENATED}[ \t]+und[ \t]+)${HYPHENATED}${RIGHT_BOUNDARY}`,
  'gu'
);

// Известные города, районы и географические названия.
// Добавлены Wichlinghausen, Freudenberg и другие районы.
const PLACE_KNOWN = new RegExp(
  String.raw`${LEFT_BOUNDARY}(?:Wuppertal|Elberfeld|Barmen|Oberbarmen|Unterbarmen|Heckinghausen|Langerfeld|Beyenburg|Ronsdorf|Cronenberg|Vohwinkel|Uellendahl|Katernberg|Sonnborn|Wichlinghausen|Wichlinghauser|Freudenberg|Solingen|Remscheid|Hagen|Velbert|Haan|Hilden|Mettmann|Schwelm|Gevelsberg|Sprockhövel|Düsseldorf|Köln|Dortmund|Essen|Bochum|Leverkusen|Hattingen|Recklinghausen|Bruchmühle|Scherenberg|Untenrohleder|Elisabetheim|Holtkamp|BEK)(?![\p{Script=Latin}\p{N}])`,
  'gu'
);

// Обычные слова, которые не должны защищаться как географические названия.
const NOT_NAME_WORD = new RegExp(
  `^(?:${NOT_A_NAME}|Fahrbahn|Fahrtrichtung|Gegenrichtung|Fahrstreifen|Standstreifen|Baustelle|Unfall|Stau|Umleitung|Verkehr|Einsatzstelle|Gefahrenstelle)$`,
  'u'
);

// Обычные слова, которые заканчиваются так же, как названия мест.
const COMMON_NOUNS =
  /^(?:Rettungsgasse|Rettungsweg|Fluchtweg|Gehweg|Radweg|Radschnellweg|Fußweg|Fussweg|Feldweg|Waldweg|Wirtschaftsweg|Zufahrtsweg|Umweg|Hinweg|Rückweg|Rueckweg|Ausweg|Parkplatz|Rastplatz|Sportplatz|Spielplatz|Festplatz|Stellplatz|Arbeitsplatz|Weihnachtsmarkt|Wochenmarkt|Flohmarkt|Bahndamm|Schutzwall|Lärmschutzwall|Rettungsring|Schutzring)$/iu;

// ------------------------------------------------------------
// ХЕШ ИСХОДНОГО ТЕКСТА
// ------------------------------------------------------------

export function textHash(title, description) {
  const s = `${title || ''}\u0000${description || ''}`;

  let h = 2166136261;

  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  return (h >>> 0).toString(16) + ':' + s.length;
}

// ------------------------------------------------------------
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ------------------------------------------------------------

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeLocationVariants(locationName) {
  const name = String(locationName || '').trim();

  if (!name) return [];

  const variants = [name];

  const suffixes = [
    [/straße$/iu, ['str.', 'str', 'straße']],
    [/strasse$/iu, ['str.', 'str', 'strasse']],
    [/str\.?$/iu, ['straße', 'strasse', 'str.']],
    [/platz$/iu, ['platz']],
    [/weg$/iu, ['weg']],
    [/allee$/iu, ['allee']],
    [/ring$/iu, ['ring']],
    [/gasse$/iu, ['gasse']],
    [/ufer$/iu, ['ufer']],
    [/damm$/iu, ['damm']]
  ];

  for (const [pattern, endings] of suffixes) {
    if (!pattern.test(name)) continue;

    const stem = name.replace(pattern, '');

    for (const ending of endings) {
      variants.push(stem + ending);
    }
  }

  return [...new Set(variants)]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
}

// ------------------------------------------------------------
// ПОИСК ЗАЩИЩЁННЫХ ФРАГМЕНТОВ
// ------------------------------------------------------------

export function findProtectedSpans(text, locationName = '') {
  const source = String(text || '');

  if (!source) return [];

  const spans = [];

  function collect(pattern, accept = () => true) {
    pattern.lastIndex = 0;

    let match;

    while ((match = pattern.exec(source)) !== null) {
      if (!match[0]) {
        pattern.lastIndex++;
        continue;
      }

      if (!accept(match[0])) continue;

      spans.push({
        start: match.index,
        end: match.index + match[0].length
      });
    }
  }

  // Сначала защищаем название, известное из location_name.
  for (const variant of makeLocationVariants(locationName)) {
    const pattern = new RegExp(
      `(?<![\\p{Script=Latin}\\p{N}])${escapeRegExp(variant)}(?![\\p{Script=Latin}\\p{N}])`,
      'giu'
    );

    collect(pattern);
  }

  // Улицы с присоединёнными окончаниями.
  collect(PLACE_JOINED, (m) => !COMMON_NOUNS.test(m));

  // Улицы с отдельным окончанием.
  collect(PLACE_SEPARATE);

  // Составные географические названия.
  collect(PLACE_HYPHEN);

  // Географические названия после вводных слов.
  collect(PLACE_AFTER_LEAD, (m) => !NOT_NAME_WORD.test(m));
  collect(PLACE_AFTER_BETWEEN, (m) => !NOT_NAME_WORD.test(m));

  // Известные города и районы.
  collect(PLACE_KNOWN);

  if (!spans.length) return [];

  // Сначала более длинные диапазоны при одинаковом начале.
  spans.sort((a, b) => a.start - b.start || b.end - a.end);

  // Объединяем пересекающиеся и соприкасающиеся диапазоны.
  const merged = [];

  for (const span of spans) {
    const last = merged[merged.length - 1];

    if (!last || span.start > last.end) {
      merged.push({ ...span });
    } else if (span.end > last.end) {
      last.end = span.end;
    }
  }

  return merged;
}

// ------------------------------------------------------------
// РАЗБИЕНИЕ ДЛИННОГО ТЕКСТА
// ------------------------------------------------------------

function splitLongLine(line, maxLength = CHUNK) {
  const source = String(line || '');

  if (source.length <= maxLength) return [source];

  const chunks = [];
  let rest = source;

  while (rest.length > maxLength) {
    let cut = rest.lastIndexOf(' ', maxLength);

    if (cut < Math.floor(maxLength * 0.5)) {
      cut = rest.indexOf(' ', maxLength);
    }

    // Если подходящего пробела нет, не разрываем слово.
    if (cut < 0) break;

    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }

  if (rest) chunks.push(rest);

  return chunks;
}

// ------------------------------------------------------------
// WORKERS AI
// ------------------------------------------------------------

async function callAI(env, text) {
  const result = await env.AI.run(MODEL, {
    text,
    source_lang: 'de',
    target_lang: 'ru'
  });

  const translated =
    result?.translated_text ??
    result?.result?.translated_text;

  if (typeof translated !== 'string' || !translated.trim()) {
    throw new Error('Workers AI вернул пустой перевод');
  }

  return translated.trim();
}

async function translatePlainText(env, text) {
  const source = String(text || '');

  if (!source.trim()) return source;

  // Переводим строки отдельно, сохраняя переносы.
  const lines = source.split('\n');
  const translatedLines = [];

  for (const line of lines) {
    if (!line.trim()) {
      translatedLines.push(line);
      continue;
    }

    const chunks = splitLongLine(line);
    const translatedChunks = [];

    for (const chunk of chunks) {
      if (!chunk.trim()) {
        translatedChunks.push(chunk);
        continue;
      }

      translatedChunks.push(await callAI(env, chunk));
    }

    translatedLines.push(translatedChunks.join(' '));
  }

  return translatedLines.join('\n');
}

// ------------------------------------------------------------
// ПЕРЕВОД ФРАГМЕНТОВ С СОХРАНЕНИЕМ ПРОБЕЛОВ
// ------------------------------------------------------------

async function translateSegment(env, seg) {
  if (!/\p{L}/u.test(seg)) return seg;

  const lead = seg.match(/^\s*/)[0];
  const trail = seg.match(/\s*$/)[0];

  const core = seg.slice(
    lead.length,
    seg.length - trail.length
  );

  if (!core) return seg;

  return lead + (await translatePlainText(env, core)) + trail;
}

// ------------------------------------------------------------
// ПЕРЕВОД ТЕКСТА С ЗАЩИТОЙ НАЗВАНИЙ
// ------------------------------------------------------------

async function translateText(env, text, locationName = '') {
  const source = String(text || '');

  if (!source.trim()) return '';

  const spans = findProtectedSpans(source, locationName);

  // Если весь текст — название улицы или места,
  // не вызываем модель.
  if (
    spans.length === 1 &&
    spans[0].start === 0 &&
    spans[0].end === source.length
  ) {
    return source.trim();
  }

  if (!spans.length) {
    return (await translatePlainText(env, source)).trim();
  }

  const output = [];
  let cursor = 0;

  for (const span of spans) {
    // Переводим обычный текст перед названием.
    if (span.start > cursor) {
      const plain = source.slice(cursor, span.start);
      output.push(await translateSegment(env, plain));
    }

    // Название вставляем без изменений.
    output.push(source.slice(span.start, span.end));

    cursor = span.end;
  }

  // Переводим остаток после последнего защищённого фрагмента.
  if (cursor < source.length) {
    output.push(
      await translateSegment(env, source.slice(cursor))
    );
  }

  // Не допускаем склеивания слов на границах фрагментов.
  return output.join('').replace(/[ \t]{2,}/g, ' ').trim();
}

// ------------------------------------------------------------
// ЧТЕНИЕ ПЕРЕВОДОВ ИЗ D1
// ------------------------------------------------------------

async function readTranslationRows(env, ids) {
  if (!ids.length) return [];

  const placeholders = ids.map(() => '?').join(',');

  const result = await env.DB.prepare(
    `SELECT
       event_id,
       text_type,
       src_hash,
       translated_text,
       original_text,
       updated_at
     FROM translations
     WHERE target_lang = 'ru'
       AND event_id IN (${placeholders})`
  ).bind(...ids).all();

  return result.results || [];
}

function groupTranslationRows(rows) {
  const grouped = new Map();

  for (const row of rows) {
    if (!grouped.has(row.event_id)) {
      grouped.set(row.event_id, {});
    }

    grouped.get(row.event_id)[row.text_type] = row;
  }

  return grouped;
}

// ------------------------------------------------------------
// ПОИСК СОБЫТИЙ, ОЖИДАЮЩИХ ПЕРЕВОДА
// ------------------------------------------------------------

async function findPendingEvents(env, limit = SCAN_LIMIT) {
  const result = await env.DB.prepare(
    `SELECT
       e.id,
       e.title,
       e.description,
       e.location_name,
       e.source
     FROM events e
     LEFT JOIN translations tt
       ON tt.event_id = e.id
       AND tt.target_lang = 'ru'
       AND tt.text_type = 'title'
     LEFT JOIN translations td
       ON td.event_id = e.id
       AND td.target_lang = 'ru'
       AND td.text_type = 'description'
     WHERE e.status IN ('LIVE','ACTIVE','RECENT')
       AND (
         tt.id IS NULL
         OR tt.src_hash IS NULL
         OR tt.original_text IS NOT e.title
         OR (
           COALESCE(e.description, '') <> ''
           AND (
             td.id IS NULL
             OR td.src_hash IS NULL
             OR td.original_text IS NOT e.description
           )
         )
         OR (
           COALESCE(e.description, '') = ''
           AND td.id IS NOT NULL
         )
       )
     ORDER BY
       CASE
         WHEN tt.id IS NULL OR tt.src_hash IS NULL THEN 0
         ELSE 1
       END,
       COALESCE(tt.updated_at, e.received_at, e.published_at) ASC
     LIMIT ?`
  ).bind(
    Math.max(1, Math.min(Number(limit) || SCAN_LIMIT, 1000))
  ).all();

  return result.results || [];
}

// ------------------------------------------------------------
// СОХРАНЕНИЕ ПЕРЕВОДОВ
// ------------------------------------------------------------

async function saveTranslation(
  env,
  event,
  hash,
  title,
  description
) {
  const now = ISO(Date.now());

  const statements = [
    env.DB.prepare(
      `INSERT INTO translations (
         id,
         event_id,
         source_lang,
         target_lang,
         original_text,
         translated_text,
         model,
         created_at,
         updated_at,
         src_hash,
         text_type
       )
       VALUES (?,?,'de','ru',?,?,?,?,?,?,'title')
       ON CONFLICT(event_id,target_lang,text_type)
       DO UPDATE SET
         original_text=excluded.original_text,
         translated_text=excluded.translated_text,
         model=excluded.model,
         updated_at=excluded.updated_at,
         src_hash=excluded.src_hash`
    ).bind(
      crypto.randomUUID(),
      event.id,
      event.title || '',
      title,
      MODEL,
      now,
      now,
      hash
    )
  ];

  if (event.description) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO translations (
           id,
           event_id,
           source_lang,
           target_lang,
           original_text,
           translated_text,
           model,
           created_at,
           updated_at,
           src_hash,
           text_type
         )
         VALUES (?,?,'de','ru',?,?,?,?,?,?,'description')
         ON CONFLICT(event_id,target_lang,text_type)
         DO UPDATE SET
           original_text=excluded.original_text,
           translated_text=excluded.translated_text,
           model=excluded.model,
           updated_at=excluded.updated_at,
           src_hash=excluded.src_hash`
      ).bind(
        crypto.randomUUID(),
        event.id,
        event.description,
        description,
        MODEL,
        now,
        now,
        hash
      )
    );
  } else {
    statements.push(
      env.DB.prepare(
        `DELETE FROM translations
         WHERE event_id = ?
           AND target_lang = 'ru'
           AND text_type = 'description'`
      ).bind(event.id)
    );
  }

  // Обе операции выполняются одной D1 batch-операцией.
  await env.DB.batch(statements);
}

// ------------------------------------------------------------
// ОСНОВНАЯ ОЧЕРЕДЬ ПЕРЕВОДА
// ------------------------------------------------------------

export async function translatePending(
  env,
  { limit = PER_RUN } = {}
) {
  if (!env.AI || typeof env.AI.run !== 'function') {
    console.warn(
      '[translate] пропуск: Workers AI binding недоступен'
    );

    return {
      skipped: 'no AI binding',
      translated: 0,
      failed: 0,
      pending: 0
    };
  }

  const safeLimit = Math.max(
    0,
    Math.min(Number(limit) || PER_RUN, 50)
  );

  if (safeLimit === 0) {
    return {
      translated: 0,
      failed: 0,
      pending: 0,
      scanned: 0
    };
  }

  const candidates = await findPendingEvents(env);
  const todo = candidates.slice(0, safeLimit);

  console.log(
    `[translate] очередь: найдено ${candidates.length}, ` +
    `в текущем запуске ${todo.length}`
  );

  if (!todo.length) {
    return {
      translated: 0,
      failed: 0,
      pending: 0,
      scanned: candidates.length
    };
  }

  let translatedCount = 0;
  let failed = 0;
  let lastError = null;
  let streak = 0;

  const failures = [];

  for (const event of todo) {
    try {
      const hash = textHash(
        event.title,
        event.description
      );

      // Заголовки Autobahn содержат названия трасс и мест.
      // Не переводим их.
      const translatedTitle =
        event.source === 'autobahn'
          ? String(event.title || '').trim()
          : await translateText(
              env,
              truncate(event.title || '', 300),
              event.location_name
            );

      let translatedDescription = null;

      if (event.description) {
        translatedDescription = await translateText(
          env,
          truncate(event.description, MAX_DESC),
          event.location_name
        );
      }

      await saveTranslation(
        env,
        event,
        hash,
        translatedTitle,
        translatedDescription
      );

      translatedCount++;
      streak = 0;

      console.log(`[translate] OK ${event.id}`);
    } catch (error) {
      failed++;
      streak++;

      lastError = error?.message || String(error);

      failures.push({
        event_id: event.id,
        error: lastError
      });

      console.error(
        `[translate] ERROR ${event.id}: ${lastError}`
      );

      // Три ошибки подряд — вероятно, проблема с AI или квотой.
      // Оставшиеся события будут обработаны следующим запуском.
      if (streak >= 3) break;
    }
  }

  const result = {
    translated: translatedCount,
    failed,
    pending: Math.max(
      0,
      candidates.length - translatedCount - failed
    ),
    scanned: candidates.length,
    attempted: todo.length,
    error: lastError,
    failures
  };

  console.log(
    `[translate] итог: ${JSON.stringify(result)}`
  );

  return result;
}

// ------------------------------------------------------------
// ЗАГРУЗКА ПЕРЕВОДОВ ДЛЯ ПУБЛИЧНОГО API
// ------------------------------------------------------------

export async function loadTranslations(env, ids) {
  const map = new Map();

  if (!ids.length) return map;

  try {
    const rows = await readTranslationRows(env, ids);
    const grouped = groupTranslationRows(rows);

    for (const [eventId, saved] of grouped) {
      const title = saved.title;

      if (!title || !title.src_hash) continue;

      if (
        saved.description &&
        saved.description.src_hash !== title.src_hash
      ) {
        continue;
      }

      map.set(eventId, {
        src_hash: title.src_hash,
        title: title.translated_text,
        description:
          saved.description?.translated_text || null
      });
    }
  } catch (error) {
    console.error(
      '[translate] не удалось загрузить переводы:',
      error?.message || String(error)
    );
  }

  return map;
}
