
import { ISO, truncate } from './util.js';

const MODEL = '@cf/meta/m2m100-1.2b';
const CHUNK = 400;
const MAX_DESC = 1600;
const PER_RUN = 6;
const SCAN_LIMIT = 500;

const SUFFIX_JOINED = '(?:[Ss]traße|[Ss]trasse|[Ss]tr\\.|[Ww]eg|[Pp]latz|[Aa]llee|[Rr]ing|[Gg]asse|[Uu]fer|[Dd]amm|[Cc]haussee|[Ss]tieg|[Bb]rücke|[Bb]ruecke|[Pp]romenade|[Ww]all|[Hh]öfe|[Hh]oefe|[Mm]arkt)';
const SUFFIX_SEPARATE = '(?:Straße|Strasse|Str\\.|Weg|Platz|Allee|Ring|Gasse|Ufer|Damm|Markt|Brücke|Promenade)';
const NAME_CHARS = String.raw`[\p{Script=Latin}\p{M}0-9'’-]`;
const LEFT_BOUNDARY = String.raw`(?<![\p{Script=Latin}\p{N}])`;
const RIGHT_BOUNDARY = String.raw`(?![\p{Script=Latin}\p{N}])`;
const NOT_A_NAME = '(?:Der|Die|Das|Den|Dem|Des|Ein|Eine|Einen|Einer|Auf|An|Am|Im|In|Zum|Zur|Bitte|Wegen|Sperrung|Vollsperrung)';

const PLACE_JOINED = new RegExp(String.raw`${LEFT_BOUNDARY}\p{Lu}${NAME_CHARS}*${SUFFIX_JOINED}${RIGHT_BOUNDARY}`, 'gu');
const PLACE_SEPARATE = new RegExp(String.raw`${LEFT_BOUNDARY}(?!${NOT_A_NAME}[ \t])\p{Lu}${NAME_CHARS}*[ \t]+${SUFFIX_SEPARATE}${RIGHT_BOUNDARY}`, 'gu');

const TOKEN = String.raw`\p{Lu}[\p{Script=Latin}\p{M}'’]*`;
const HYPHENATED = String.raw`${TOKEN}(?:-${TOKEN})*`;

const PLACE_HYPHEN = new RegExp(String.raw`(?<![\p{Script=Latin}\p{N}-])${TOKEN}(?:-${TOKEN})+${RIGHT_BOUNDARY}`, 'gu');

const LEAD_WORDS = '(?:Richtung|zwischen|Anschlussstelle|Autobahnkreuz|Autobahndreieck|Dreieck|Kreuz|AS|AK|AD)';
const PLACE_AFTER_LEAD = new RegExp(String.raw`(?<=${LEAD_WORDS}[ \t]+)${HYPHENATED}${RIGHT_BOUNDARY}`, 'gu');
const PLACE_AFTER_BETWEEN = new RegExp(String.raw`(?<=zwischen[ \t]+${HYPHENATED}[ \t]+und[ \t]+)${HYPHENATED}${RIGHT_BOUNDARY}`, 'gu');

const PLACE_KNOWN = new RegExp(String.raw`${LEFT_BOUNDARY}(?:Wuppertal|Elberfeld|Barmen|Oberbarmen|Unterbarmen|Heckinghausen|Langerfeld|Beyenburg|Ronsdorf|Cronenberg|Vohwinkel|Uellendahl|Katernberg|Sonnborn|Wichlinghausen|Wichlinghauser|Freudenberg|Solingen|Remscheid|Hagen|Velbert|Haan|Hilden|Mettmann|Schwelm|Gevelsberg|Sprockhövel|Düsseldorf|Köln|Dortmund|Essen|Bochum|Leverkusen|Hattingen|Recklinghausen|Bruchmühle|Scherenberg|Untenrohleder|Elisabetheim|Holtkamp|BEK)${RIGHT_BOUNDARY}`, 'gu');

const PLACE_ABBR = new RegExp(String.raw`${LEFT_BOUNDARY}(?:AS|AK|AD|BW|BEK|ALD|AkD|AKD)(?:[ \t]+\d{2,})?${RIGHT_BOUNDARY}`, 'gu');
const PLACE_ROAD = new RegExp(String.raw`${LEFT_BOUNDARY}[ABLK]\d{1,4}${RIGHT_BOUNDARY}`, 'gu');

const NOT_NAME_WORD = new RegExp(`^(?:${NOT_A_NAME}|Fahrbahn|Fahrtrichtung|Gegenrichtung|Fahrstreifen|Standstreifen|Baustelle|Unfall|Stau|Umleitung|Verkehr|Einsatzstelle|Gefahrenstelle|Behinderung|Behinderungen|Bauarbeiten|Arbeiten|Gefahr|Unfälle|Sperrungen|Fahrbahnverengung|Einschränkungen|Rettungsgasse)$`, 'u');

const COMMON_NOUNS = /^(?:Rettungsgasse|Rettungsweg|Fluchtweg|Gehweg|Radweg|Radschnellweg|Fußweg|Fussweg|Feldweg|Waldweg|Wirtschaftsweg|Zufahrtsweg|Umweg|Hinweg|Rückweg|Rueckweg|Ausweg|Parkplatz|Rastplatz|Sportplatz|Spielplatz|Festplatz|Stellplatz|Arbeitsplatz|Weihnachtsmarkt|Wochenmarkt|Flohmarkt|Bahndamm|Schutzwall|Lärmschutzwall|Rettungsring|Schutzring)$/iu;

export function textHash(title, description) {
  const s = `${title || ''}\u0000${description || ''}`;
  let h = 2166136261;

  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  return (h >>> 0).toString(16) + ':' + s.length;
}

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

function mergeSpans(source, spans) {
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];

  for (const sp of spans) {
    const last = out[out.length - 1];

    if (last && (sp.start <= last.end || /^[ \t]+$/.test(source.slice(last.end, sp.start)))) {
      if (sp.end > last.end) last.end = sp.end;
    } else {
      out.push({ ...sp });
    }
  }

  return out;
}

const PREP_BEFORE = /(?:zwischen|und|sowie|,|;)([ \t]+)((?:Am|Im|An|Auf|Beim|Zum|Zur|Vom)(?:[ \t]+(?:der|dem|den))?[ \t]+)$/u;

const LIST_SEP = String.raw`(?:[ \t]*[,;][ \t]*|[ \t]+(?:und|sowie)[ \t]+)`;
const LIST_ITEM = String.raw`((?:(?:Am|Im|An|Auf|In|Beim|Zum|Zur|Vom)[ \t]+(?:(?:der|dem|den|die|das)[ \t]+)?)?\p{Lu}[\p{Script=Latin}\p{M}'’.-]*(?:[ \t]+\p{Lu}[\p{Script=Latin}\p{M}'’.-]*){0,2})`;
const LIST_GAP = new RegExp(`^${LIST_SEP}${LIST_ITEM}${LIST_SEP}(?:(?:am|im|an|auf|in|zum|zur|beim|vom)[ \\t]+)?$`, 'u');

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

  for (const variant of makeLocationVariants(locationName)) {
    const pattern = new RegExp(
      `(?<![\\p{Script=Latin}\\p{N}])${escapeRegExp(variant)}(?![\\p{Script=Latin}\\p{N}])`,
      'giu'
    );
    collect(pattern);
  }

  collect(PLACE_JOINED, (m) => !COMMON_NOUNS.test(m));
  collect(PLACE_SEPARATE);
  collect(PLACE_HYPHEN);
  collect(PLACE_AFTER_LEAD, (m) => !NOT_NAME_WORD.test(m));
  collect(PLACE_AFTER_BETWEEN, (m) => !NOT_NAME_WORD.test(m));
  collect(PLACE_KNOWN);
  collect(PLACE_ABBR);
  collect(PLACE_ROAD);

  if (!spans.length) return [];

  let merged = mergeSpans(source, spans);

  for (const m of merged) {
    const before = source.slice(0, m.start).match(PREP_BEFORE);
    if (before) m.start -= before[2].length;
  }

  const extra = [];

  for (let k = 0; k + 1 < merged.length; k++) {
    const gap = source.slice(merged[k].end, merged[k + 1].start);
    const m = gap.match(LIST_GAP);

    if (!m) continue;

    const item = m[1];
    const first = item.split(/\s+/)[0];

    if (!item.includes(' ') && NOT_NAME_WORD.test(first)) continue;

    const at = merged[k].end + gap.indexOf(item);
    extra.push({ start: at, end: at + item.length });
  }

  if (extra.length) merged = mergeSpans(source, [...merged, ...extra]);

  return merged;
}

function splitLongLine(line, maxLength = CHUNK) {
  const source = String(line || '');
  if (source.length <= maxLength) return [source];

  const chunks = [];
  let rest = source;

  while (rest.length > maxLength) {
    let cut = rest.lastIndexOf(' ', maxLength);
    if (cut < Math.floor(maxLength * 0.5)) cut = rest.indexOf(' ', maxLength);
    if (cut < 0) break;

    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }

  if (rest) chunks.push(rest);
  return chunks;
}

const MAX_AI_CALLS = 40;
const aiBudget = { left: MAX_AI_CALLS };

class BudgetExceeded extends Error {}

async function callAI(env, text) {
  if (aiBudget.left <= 0) {
    throw new BudgetExceeded('исчерпан лимит обращений к модели за запуск');
  }

  aiBudget.left--;

  const result = await env.AI.run(MODEL, {
    text,
    source_lang: 'de',
    target_lang: 'ru'
  });

  const translated = result?.translated_text ?? result?.result?.translated_text;

  if (typeof translated !== 'string' || !translated.trim()) {
    throw new Error('Workers AI вернул пустой перевод');
  }

  return translated.trim();
}

const ABBREVIATIONS = [
  [/\bErn\./g, 'Erneuerung'],
  [/\bInst\./g, 'Instandsetzung'],
  [/\bRtg\./g, 'Richtung']
];

const expandAbbreviations = (t) =>
  ABBREVIATIONS.reduce((acc, [re, full]) => acc.replace(re, full), t);

const PART_SEPARATOR = /( · | \| )/;
const LEAD_EDGE = /^[\s.,;:!?)\]»"'·|/>–—-]*/u;
const TRAIL_EDGE = /[\s,;:([«"'·|/<–—-]*$/u;

async function translateChunks(env, core) {
  const out = [];

  for (const chunk of splitLongLine(core)) {
    out.push(chunk.trim() ? await callAI(env, expandAbbreviations(chunk)) : chunk);
  }

  return out.join(' ');
}

async function translatePart(env, part) {
  if (!/\p{L}/u.test(part)) return part;

  const lead = part.match(LEAD_EDGE)[0];
  const trail = part.slice(lead.length).match(TRAIL_EDGE)[0];
  const core = part.slice(lead.length, part.length - trail.length);

  if (!core || !/\p{L}/u.test(core)) return part;

  return lead + (await translateChunks(env, core)) + trail;
}

async function translatePlainText(env, text) {
  const source = String(text || '');
  if (!source.trim()) return source;

  const lines = [];

  for (const line of source.split('\n')) {
    if (!line.trim()) {
      lines.push(line);
      continue;
    }

    const parts = line.split(PART_SEPARATOR);
    const done = [];

    for (let i = 0; i < parts.length; i++) {
      done.push(i % 2 === 1 ? parts[i] : await translatePart(env, parts[i]));
    }

    lines.push(done.join(''));
  }

  return lines.join('\n');
}

const translateSegment = translatePlainText;

function glue(acc, piece) {
  if (!piece) return acc;

  if (acc && /[\p{L}\p{N}]$/u.test(acc) && /^[\p{L}\p{N}]/u.test(piece)) {
    return acc + ' ' + piece;
  }

  return acc + piece;
}

async function translateText(env, text, locationName = '') {
  const source = String(text || '');
  if (!source.trim()) return '';

  const spans = findProtectedSpans(source, locationName);

  if (spans.length === 1 && spans[0].start === 0 && spans[0].end === source.length) {
    return source.trim();
  }

  if (!spans.length) {
    return (await translatePlainText(env, source)).trim();
  }

  let out = '';
  let cursor = 0;

  for (const span of spans) {
    if (span.start > cursor) {
      out = glue(out, await translateSegment(env, source.slice(cursor, span.start)));
    }

    out = glue(out, source.slice(span.start, span.end));
    cursor = span.end;
  }

  if (cursor < source.length) {
    out = glue(out, await translateSegment(env, source.slice(cursor)));
  }

  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

async function readTranslationRows(env, ids) {
  if (!ids.length) return [];

  const placeholders = ids.map(() => '?').join(',');

  const result = await env.DB.prepare(
    `SELECT event_id,text_type,src_hash,translated_text,original_text,updated_at
     FROM translations
     WHERE target_lang = 'ru'
       AND event_id IN (${placeholders})`
  ).bind(...ids).all();

  return result.results || [];
}

function groupTranslationRows(rows) {
  const grouped = new Map();

  for (const row of rows) {
    if (!grouped.has(row.event_id)) grouped.set(row.event_id, {});
    grouped.get(row.event_id)[row.text_type] = row;
  }

  return grouped;
}

async function findPendingEvents(env, limit = SCAN_LIMIT) {
  const safeLimit = Math.max(
    1,
    Math.min(Number(limit) || SCAN_LIMIT, 1000)
  );

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
       CASE WHEN tt.id IS NULL OR tt.src_hash IS NULL THEN 0 ELSE 1 END,
       COALESCE(tt.updated_at, e.received_at, e.published_at) ASC
     LIMIT ?`
  ).bind(safeLimit).all();

  return result.results || [];
}

async function saveTranslation(env, event, hash, title, description, modelName = MODEL) {
  const now = ISO(Date.now());

  const statements = [
    env.DB.prepare(
      `INSERT INTO translations (
         id,event_id,source_lang,target_lang,original_text,translated_text,
         model,created_at,updated_at,src_hash,text_type
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
      modelName,
      now,
      now,
      hash
    )
  ];

  if (event.description) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO translations (
           id,event_id,source_lang,target_lang,original_text,translated_text,
           model,created_at,updated_at,src_hash,text_type
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
        modelName,
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

  await env.DB.batch(statements);
}

// ---------- движки перевода ----------
// DeepL используется при наличии DEEPL_API_KEY.
// В противном случае используется только M2M100.
// Gemma и другие LLM здесь больше не используются.

export function pickEngine(env) {
  const forced = String(env.TRANSLATE_PROVIDER || '').toLowerCase();
  const hasAI = !!(env.AI && typeof env.AI.run === 'function');
  const hasDeepL = !!env.DEEPL_API_KEY;

  if (forced === 'deepl') {
    return hasDeepL ? 'deepl' : (hasAI ? 'm2m' : null);
  }

  // Старое значение llm намеренно перенаправляем на M2M100.
  if (forced === 'm2m' || forced === 'llm') {
    return hasAI ? 'm2m' : null;
  }

  if (hasDeepL) return 'deepl';

  return hasAI ? 'm2m' : null;
}

const hasLetters = (t) => /\p{L}{3,}/u.test(String(t || ''));
const hasCyrillic = (t) => /\p{Script=Cyrillic}/u.test(String(t || ''));

function validateTranslation(source, translated, locationName) {
  const out = String(translated || '').trim();

  if (!out) throw new Error('пустой перевод');

  if (source.length >= 12 && hasLetters(source) && !hasCyrillic(out)) {
    throw new Error('в переводе нет русского текста');
  }

  if (out.length > source.length * 4 + 60) {
    throw new Error('перевод подозрительно длинный');
  }

  for (const sp of findProtectedSpans(source, locationName)) {
    const name = source.slice(sp.start, sp.end);

    if (!out.includes(name)) {
      throw new Error(`название «${name}» изменено в переводе`);
    }
  }

  return out;
}

// --- DeepL ---

const xmlEscape = (t) =>
  String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const xmlUnescape = (t) =>
  String(t)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

function wrapNames(text, locationName) {
  const spans = findProtectedSpans(text, locationName);
  let out = '';
  let cursor = 0;

  for (const sp of spans) {
    out += xmlEscape(text.slice(cursor, sp.start));
    out += '<x>' + xmlEscape(text.slice(sp.start, sp.end)) + '</x>';
    cursor = sp.end;
  }

  return out + xmlEscape(text.slice(cursor));
}

async function deeplRequest(env, texts, ignoreTags) {
  const key = String(env.DEEPL_API_KEY);
  const host = env.DEEPL_API_HOST || (key.endsWith(':fx') ? 'api-free.deepl.com' : 'api.deepl.com');

  const body = {
    text: texts,
    source_lang: 'DE',
    target_lang: 'RU',
    tag_handling: 'xml',
    tag_handling_version: 'v2',
    ignore_tags: ignoreTags,
    split_sentences: 'nonewlines',
    context: 'Amtliche Meldung, Polizei- oder Feuerwehrbericht oder Verkehrsmeldung aus Wuppertal'
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);

  try {
    return await fetch(`https://${host}/v2/translate`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: `DeepL-Auth-Key ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
  } finally {
    clearTimeout(timer);
  }
}

async function translateDeepL(env, event, keepTitle) {
  const sources = keepTitle ? [] : [truncate(event.title || '', 300)];

  if (event.description) {
    sources.push(truncate(event.description, MAX_DESC));
  }

  if (!sources.length) {
    return {
      title: String(event.title || '').trim(),
      description: null,
      model: 'deepl'
    };
  }

  const texts = sources.map((t) => wrapNames(t, event.location_name));

  let res = await deeplRequest(env, texts, ['x']);

  if (res.status === 400) {
    res = await deeplRequest(env, texts, 'x');
  }

  if (res.status === 456) {
    throw new Error('DeepL: квота символов исчерпана');
  }

  if (!res.ok) {
    throw new Error(`DeepL: HTTP ${res.status}`);
  }

  const data = await res.json();
  const list = Array.isArray(data.translations) ? data.translations : [];

  if (list.length !== sources.length) {
    throw new Error('DeepL: неожиданный ответ');
  }

  const clean = list.map((t, i) =>
    validateTranslation(
      sources[i],
      xmlUnescape(String(t.text || '').replace(/<\/?x>/g, '')),
      event.location_name
    )
  );

  return keepTitle
    ? {
        title: String(event.title || '').trim(),
        description: clean[0] || null,
        model: 'deepl'
      }
    : {
        title: clean[0],
        description: clean[1] || null,
        model: 'deepl'
      };
}

// --- M2M100 ---

async function translateM2m(env, event, keepTitle = false) {
  const title = keepTitle
    ? String(event.title || '').trim()
    : await translateText(env, truncate(event.title || '', 300), event.location_name);

  const description = event.description
    ? await translateText(env, truncate(event.description, MAX_DESC), event.location_name)
    : null;

  return {
    title,
    description,
    model: MODEL
  };
}

async function translateEvent(env, event, engine) {
  const keepTitle = event.source === 'autobahn';

  let out;

  if (engine === 'deepl') {
    out = await translateDeepL(env, event, keepTitle);
  } else {
    out = await translateM2m(env, event, keepTitle);
  }

  if (keepTitle) {
    out.title = String(event.title || '').trim();
  }

  return out;
}

export async function translatePending(env, { limit = PER_RUN } = {}) {
  const engine = pickEngine(env);

  if (!engine) {
    console.warn('[translate] пропуск: нет доступного движка перевода (DeepL или M2M100)');

    return {
      skipped: 'no translation engine',
      translated: 0,
      failed: 0,
      pending: 0
    };
  }

  const requestedLimit = Number(limit);

  const safeLimit = Number.isFinite(requestedLimit)
    ? Math.max(0, Math.min(Math.floor(requestedLimit), 50))
    : PER_RUN;

  if (safeLimit === 0) {
    return {
      translated: 0,
      failed: 0,
      pending: 0,
      scanned: 0,
      attempted: 0,
      skipped: 0
    };
  }

  aiBudget.left = MAX_AI_CALLS;

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
      scanned: candidates.length,
      attempted: 0,
      skipped: 0
    };
  }

  let translatedCount = 0;
  let failed = 0;
  let lastError = null;
  let streak = 0;
  let skipped = 0;

  const failures = [];

  for (const event of todo) {
    const budgetBefore = aiBudget.left;

    try {
      const hash = textHash(event.title, event.description);

      const out = await translateEvent(env, event, engine);

      await saveTranslation(
        env,
        event,
        hash,
        out.title,
        out.description,
        out.model
      );

      translatedCount++;
      streak = 0;

      console.log(`[translate] OK ${event.id}`);
    } catch (error) {
      if (error instanceof BudgetExceeded) {
        if (budgetBefore === MAX_AI_CALLS) {
          try {
            await saveTranslation(
              env,
              event,
              textHash(event.title, event.description),
              null,
              null,
              'skipped'
            );
            skipped++;
          } catch {
            // Не удалось сохранить пропуск — событие останется в очереди.
          }

          console.warn(
            `[translate] SKIP ${event.id}: текст слишком большой для одного запуска`
          );

          aiBudget.left = MAX_AI_CALLS;
          continue;
        }

        break;
      }

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

      if (streak >= 3) {
        break;
      }
    }
  }

  const result = {
    translated: translatedCount,
    skipped,
    failed,
    pending: Math.max(
      0,
      candidates.length - translatedCount - failed - skipped
    ),
    scanned: candidates.length,
    attempted: translatedCount + failed + skipped,
    error: lastError,
    failures
  };

  console.log(`[translate] итог: ${JSON.stringify(result)}`);

  return result;
}

export async function loadTranslations(env, ids) {
  const map = new Map();

  if (!ids.length) return map;

  try {
    const rows = await readTranslationRows(env, ids);
    const grouped = groupTranslationRows(rows);

    for (const [eventId, saved] of grouped) {
      const title = saved.title;

      if (!title || !title.src_hash || !title.translated_text) {
        continue;
      }

      if (
        saved.description &&
        saved.description.src_hash !== title.src_hash
      ) {
        continue;
      }

      map.set(eventId, {
        src_hash: title.src_hash,
        title: title.translated_text,
        description: saved.description?.translated_text || null
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
