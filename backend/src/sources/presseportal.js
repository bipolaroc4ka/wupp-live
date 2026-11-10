// Presseportal (news aktuell / dpa) — пресс-релизы Feuerwehr Wuppertal и (по желанию) Polizei Wuppertal.
// Нужен API-ключ (секрет PRESSEPORTAL_API_KEY), его выдаёт https://api.presseportal.de — там же условия использования.
//
// ЧЕСТНО О ДАННЫХ:
//  * Это пресс-релизы, а не диспетчерская лента: публикация идёт через часы после события, и не обо всех выездах.
//  * Поэтому статус всегда RECENT («актуальность неизвестна»), никогда LIVE/ACTIVE.
//  * Время происшествия берётся только из текста релиза; если не найдено — «неизвестно». Время публикации не подставляется.
//  * Полицейский newsroom охватывает Wuppertal, Remscheid и Solingen: берутся только релизы с датой-строкой «Wuppertal (ots)».
//
// ВАЖНО: формат ответа API в этой разработке не проверялся вживую (нужен ключ). Парсер защитный;
// проверьте форму через админку: «Проба» (GET /api/admin/sources/presseportal/probe).
// Адрес и название параметра ключа вынесены в константы ниже на случай расхождения с документацией.

import { fetchJson, truncate } from '../util.js';
import { syncSource } from '../events.js';
import { extractStreet, geocodeStreet } from '../geo.js';
import { parseEventTime } from '../time.js';

export const meta = {
  id: 'presseportal',
  name: 'Presseportal: Feuerwehr / Polizei Wuppertal',
  intervalSec: 600,
  cron: '*/10 * * * *',
  group: 'emergency'
};

const API_BASE = 'https://api.presseportal.de/api';
const KEY_PARAM = 'api_key';
const MAX_AGE_DAYS = 7;

function officeIds(env) {
  return String(env.PRESSEPORTAL_OFFICE_IDS || '115885').split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
}

function stories(json) {
  const c = (json && json.content) ?? json;
  let s = c && (c.story ?? c.stories ?? c.article);
  if (!s && Array.isArray(c)) s = c;
  if (!s) return [];
  return Array.isArray(s) ? s : [s];
}

function dateline(body) {
  const m = String(body || '').match(/^\s*([^()\n]{2,60}?)\s*\(ots\)/);
  return m ? m[1].trim() : null;
}

function classify(text, publisher) {
  const t = text.toLowerCase();
  if (/gefahrstoff|gasaustritt|einsturz|explosion|bombe|kampfmittel|evakuier/.test(t)) return 'hazard';
  if (/\b\w*brand\b|\bfeuer(?!wehr)\w*|rauchentwicklung|löscharbeiten|flammen/.test(t)) return 'fire';
  if (/verkehrsunfall|unfall|kollision|zusammenstoß/.test(t)) return 'accident';
  if (publisher === 'police') return 'police';
  if (/rettungsdienst|reanimation|rettungswagen|notarzt/.test(t)) return 'rescue';
  return 'emergency_other';
}

function toItem(s, nowMs, ttlMs) {
  const id = s.id ?? s.story_id;
  const title0 = String(s.title || '').trim();
  const body = String(s.body || s.teaser || '').trim();
  const published = Date.parse(s.published || s.pubDate || s.date || '');
  if (id == null || !title0 || !Number.isFinite(published)) return null; // без времени публикации не показываем

  const line = dateline(body);
  const text = `${title0} ${body}`;
  if (line ? !/wuppertal/i.test(line) : !/wuppertal/i.test(text)) return null;
  if (nowMs - published > MAX_AGE_DAYS * 24 * 3600e3) return null;

  const publisher = /^POL/i.test(title0) ? 'police' : /^FW/i.test(title0) ? 'fire' : (s.office_type === 'police' ? 'police' : 'fire');
  const publisherName = publisher === 'police' ? 'Polizei Wuppertal' : 'Feuerwehr Wuppertal';
  const title = title0.replace(/^(?:FW|POL)-[A-Z]+\s*(?:\(\d+\))?\s*:\s*/i, '').trim() || title0;
  const clean = body.replace(/^\s*[^()\n]{2,60}?\s*\(ots\)\s*[-–]?\s*/, '').replace(/\s+/g, ' ').trim();

  const et = parseEventTime(`${title0}. ${body}`, published);
  const expiresMs = published + ttlMs;
  const expired = nowMs >= expiresMs;
  const street = extractStreet(`${title0}. ${body}`);

  const item = {
    source_event_id: String(id),
    publisher: publisherName,
    title,
    description: truncate(clean, 420) || null,
    category: classify(text, publisher),
    source_url: s.url || `https://www.presseportal.de/story/${id}`,
    geo_precision: 'none',
    location_name: street,
    event_time: et.ms != null ? new Date(et.ms).toISOString() : null,
    time_precision: et.precision,
    published_at: new Date(published).toISOString(),
    status: expired ? 'EXPIRED' : 'RECENT',
    status_reason: expired ? 'ttl' : 'press_release_actuality_unknown',
    confidence: 0.5,
    is_verified: 1,
    expires_at: new Date(expiresMs).toISOString()
  };

  if (street && !expired) {
    item.enrich = async (ctx) => {
      const g = await geocodeStreet(ctx, street);
      if (!g) { item.geocode_attempts = 1; return; }
      if (g.pending) return; // позже повторит retryGeocoding
      item.geo_precision = g.precision;
      item.district = g.district || null;
      item.confidence = 0.6;
      if (g.precision === 'street') { item.latitude = g.lat; item.longitude = g.lon; }
      // district: координаты не сохраняем — на карте рисуется только приблизительная область района
    };
  }
  return item;
}

async function fetchOffice(env, id) {
  const q = new URLSearchParams({ [KEY_PARAM]: env.PRESSEPORTAL_API_KEY, format: 'json', limit: '30' });
  return fetchJson(`${API_BASE}/article/publicservice/office/${id}?${q}`);
}

export async function run(ctx) {
  if (!ctx.env.PRESSEPORTAL_API_KEY) throw new Error('PRESSEPORTAL_API_KEY is not set');
  const ids = officeIds(ctx.env);
  if (!ids.length) throw new Error('PRESSEPORTAL_OFFICE_IDS is empty');
  const ttlMs = Math.max(1, parseFloat(ctx.env.PRESS_TTL_HOURS) || 12) * 3600e3;

  const items = [];
  let ok = 0, lastErr = null;
  for (const id of ids) {
    try {
      const { json } = await fetchOffice(ctx.env, id);
      ok += 1;
      for (const s of stories(json)) {
        const it = toItem(s, ctx.now, ttlMs);
        if (it) items.push(it);
      }
    } catch (e) { lastErr = e; ctx.log(`presseportal office ${id}: ${e.message}`); }
  }
  if (!ok) throw lastErr || new Error('Presseportal request failed');
  // Релизы не «завершаются» по исчезновению из списка: их актуальность ограничивается только TTL.
  return syncSource(ctx, meta.id, items, { resolveMissing: false });
}

export async function probe(ctx) {
  if (!ctx.env.PRESSEPORTAL_API_KEY) throw new Error('PRESSEPORTAL_API_KEY is not set');
  const id = officeIds(ctx.env)[0];
  const { text } = await fetchOffice(ctx.env, id);
  return { url: `${API_BASE}/article/publicservice/office/${id}?${KEY_PARAM}=***&format=json&limit=30`, sample: text.slice(0, 1500) };
}
