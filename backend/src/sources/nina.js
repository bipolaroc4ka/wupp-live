// NINA / Bundesamt für Bevölkerungsschutz — официальные предупреждения (MoWaS, DWD, LHP, KATWARN, BIWAPP).
// Эндпоинт: https://warnung.bund.de/api31/dashboard/{ARS}.json (перечислен в документации bundesAPI «deutschland/nina»).
// ВАЖНО: структура ответа dashboard в этой разработке не проверялась вживую (доступа к API из среды разработки не было),
// поэтому разбор защитный: записи без идентификатора или заголовка пропускаются, а не выдумываются.
// Как проверить форму ответа: админка -> Источники -> «Проба» (GET /api/admin/sources/nina/probe).
//
// Предупреждение относится ко всему городу -> geo_precision = 'city', координат нет (на карте не рисуется).
// Статус ACTIVE, пока запись есть в dashboard; пропала два запуска подряд (или msgType=Cancel) -> RESOLVED.

import { CITY } from '../config.js';
import { fetchJson } from '../util.js';
import { syncSource } from '../events.js';

export const meta = {
  id: 'nina',
  name: 'NINA (BBK, DWD, Länderübergreifendes Hochwasserportal)',
  intervalSec: 300,
  cron: '*/5 * * * *',
  group: 'warning'
};

function classify(text, provider) {
  const t = text.toLowerCase();
  if (/starkregen/.test(t)) return 'heavy_rain';
  if (provider === 'LHP' || /hochwasser|überflutung|ueberflutung|pegel/.test(t)) return 'flood';
  return 'warning_other';
}

function toItem(raw) {
  if (!raw || typeof raw !== 'object' || raw.id == null) return null;
  const data = raw.payload && raw.payload.data ? raw.payload.data : {};
  const title = (raw.i18nTitle && (raw.i18nTitle.de || Object.values(raw.i18nTitle)[0])) || data.headline;
  if (!title) return null;
  if (String(data.msgType || '').toLowerCase() === 'cancel') return null;
  const provider = String(data.provider || '').toUpperCase() || null;
  const sent = Date.parse(raw.sent || raw.startDate || '');

  return {
    source_event_id: String(raw.id),
    publisher: provider ? `NINA / ${provider}` : 'NINA',
    title: String(title).trim(),
    description: provider ? `Amtliche Warnung (${provider}) für das Stadtgebiet Wuppertal. Details in der Warn-App NINA.` : null,
    category: classify(String(title), provider),
    source_url: 'https://warnung.bund.de/',
    geo_precision: 'city',
    location_name: CITY.name,
    event_time: null,              // источник не сообщает время самого явления
    time_precision: 'unknown',
    published_at: Number.isFinite(sent) ? new Date(sent).toISOString() : null,
    status: 'ACTIVE',
    status_reason: 'listed_in_current_source_feed',
    confidence: 0.9,
    is_verified: 1,
    severity: data.severity ? String(data.severity) : null
  };
}

function listOf(json) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object') {
    const arr = Object.values(json).find(Array.isArray);
    if (arr) return arr;
  }
  return [];
}

function url(env) {
  const ars = /^\d{12}$/.test(env.NINA_ARS || '') ? env.NINA_ARS : CITY.ars;
  return `https://warnung.bund.de/api31/dashboard/${ars}.json`;
}

export async function run(ctx) {
  const { json } = await fetchJson(url(ctx.env));
  const items = listOf(json).map(toItem).filter(Boolean);
  const scope = null; // единственный запрос: успех = можно завершать пропавшие
  return syncSource(ctx, meta.id, items, { resolveMissing: true, resolvedScopes: null, scope });
}

export async function probe(ctx) {
  const u = url(ctx.env);
  const { text } = await fetchJson(u);
  return { url: u, sample: text.slice(0, 1500) };
}
