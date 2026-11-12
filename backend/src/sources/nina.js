
 // Wuppertal Live — NINA / BBK / DWD / MoWaS / KATWARN / BIWAPP.
 // Получение dashboard + подробностей CAP.
 // Дополнительные сведения сохраняются в стандартных колонках events.
 // API31 нестабилен: неизвестные структуры обрабатываются защитно.

import { CITY } from '../config.js';
import { fetchJson } from '../util.js';
import { syncSource } from '../events.js';

const BASE_URL = 'https://warnung.bund.de/api31';
const DETAIL_CONCURRENCY = 5;
const MAX_DESCRIPTION = 12000;

export const meta = {
  id: 'nina',
  name: 'NINA / BBK',
  intervalSec: 300,
  cron: '*/5 * * * *',
  group: 'warning'
};

// -------------------- helpers --------------------

function clean(value) {
  if (value == null) return null;

  const text = String(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<\/li>\s*<li[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text || null;
}

function first(...values) {
  for (const value of values) {
    if (value == null) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    return value;
  }
  return null;
}

function arr(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function iso(value) {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function truncateText(value, max = MAX_DESCRIPTION) {
  const text = clean(value);
  if (!text) return null;
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}

function ars(env) {
  return /^\d{12}$/.test(env.NINA_ARS || '')
    ? env.NINA_ARS
    : CITY.ars;
}

function dashboardUrl(env) {
  return `${BASE_URL}/dashboard/${ars(env)}.json`;
}

function detailUrl(id) {
  return `${BASE_URL}/warnings/${encodeURIComponent(id)}.json`;
}

function geoJsonUrl(id) {
  return `${BASE_URL}/warnings/${encodeURIComponent(id)}.geojson`;
}

function officialUrl(id) {
  return `https://warnung.bund.de/meldung/${encodeURIComponent(id)}`;
}

// -------------------- CAP parsing --------------------

function getInfo(detail) {
  const info = first(
    detail?.info,
    detail?.payload?.info,
    detail?.warning?.info
  );

  if (!Array.isArray(info)) return info || {};

  // Предпочитаем немецкую локализацию.
  return info.find((x) =>
    String(x?.language || '').toUpperCase().startsWith('DE')
  ) || info[0] || {};
}

function getDashboardData(item) {
  return item?.payload?.data || item?.data || {};
}

function getMsgType(item, detail) {
  return String(first(
    detail?.msgType,
    item?.payload?.type,
    item?.type,
    getDashboardData(item)?.msgType
  ) || 'Alert').toUpperCase();
}

function getTitle(item, detail, info) {
  const data = getDashboardData(item);

  return clean(first(
    info?.headline,
    item?.i18nTitle?.de,
    data?.headline,
    item?.headline,
    ...Object.values(item?.i18nTitle || {})
  ));
}

function getProvider(item, detail) {
  const data = getDashboardData(item);

  return String(first(
    detail?.sender,
    data?.provider,
    item?.provider
  ) || 'BBK').trim();
}

function getAreas(info) {
  return arr(info?.area)
    .map((area) => clean(area?.areaDesc))
    .filter(Boolean);
}

function getParameters(info) {
  return arr(info?.parameter)
    .filter((p) => p && typeof p === 'object')
    .map((p) => ({
      name: clean(p.valueName),
      value: clean(p.value)
    }))
    .filter((p) => p.name || p.value);
}

function getCategories(info) {
  return arr(info?.category)
    .map(clean)
    .filter(Boolean);
}

function classify(title, event, categories, provider) {
  const text = [
    title,
    event,
    ...categories,
    provider
  ].join(' ').toLowerCase();

  if (/starkregen|sturzflut|flash flood/.test(text)) {
    return 'heavy_rain';
  }

  if (/hochwasser|überschwemm|ueberschwemm|überflutung|ueberflutung|pegel/.test(text)) {
    return 'flood';
  }

  if (/orkan|sturm|windbö|windboe/.test(text)) {
    return 'storm';
  }

  if (/schnee|glätte|glaette|eisregen|frost/.test(text)) {
    return 'weather';
  }

  if (/rauch|brand|explosion|gefahrstoff|chemikal/.test(text)) {
    return 'fire';
  }

  if (/dwd/.test(String(provider).toLowerCase())) {
    return 'weather';
  }

  return 'warning_other';
}

function buildDescription(info, item, detail, provider) {
  const data = getDashboardData(item);
  const sections = [];

  const description = clean(first(
    info?.description,
    data?.description
  ));

  const instruction = clean(first(
    info?.instruction,
    data?.instruction
  ));

  const event = clean(first(
    info?.event,
    data?.event
  ));

  const areas = getAreas(info);
  const parameters = getParameters(info);
  const categories = getCategories(info);

  const urgency = clean(info?.urgency);
  const certainty = clean(info?.certainty);
  const responseType = arr(info?.responseType).map(clean).filter(Boolean);
  const contact = clean(first(info?.contact, detail?.contact));
  const web = clean(first(info?.web, detail?.web));

  if (description) {
    sections.push(description);
  }

  if (instruction) {
    sections.push(`Рекомендации населению:\n${instruction}`);
  }

  if (event) {
    sections.push(`Тип опасности: ${event}`);
  }

  if (categories.length) {
    sections.push(`Категории: ${categories.join(', ')}`);
  }

  if (areas.length) {
    sections.push(`Зона предупреждения: ${areas.join('; ')}`);
  }

  if (urgency) {
    sections.push(`Срочность: ${urgency}`);
  }

  if (certainty) {
    sections.push(`Достоверность: ${certainty}`);
  }

  if (responseType.length) {
    sections.push(`Меры реагирования: ${responseType.join(', ')}`);
  }

  if (parameters.length) {
    sections.push(
      'Дополнительные параметры:\n' +
      parameters.map((p) => `${p.name || 'Параметр'}: ${p.value || '—'}`).join('\n')
    );
  }

  if (contact) {
    sections.push(`Контакт: ${contact}`);
  }

  if (web) {
    sections.push(`Дополнительная информация: ${web}`);
  }

  if (!sections.length) {
    sections.push(`Официальное предупреждение ${provider} для Wuppertal.`);
  }

  return truncateText(sections.join('\n\n'));
}

// -------------------- normalization --------------------

function toItem(item, detail = null) {
  if (!item || typeof item !== 'object' || item.id == null) {
    return null;
  }

  const info = getInfo(detail);
  const msgType = getMsgType(item, detail);

  // Отмена не является новым активным предупреждением.
  if (msgType === 'CANCEL') return null;

  const title = getTitle(item, detail, info);
  if (!title) return null;

  const provider = getProvider(item, detail);
  const data = getDashboardData(item);

  const event = clean(first(info?.event, data?.event));
  const categories = getCategories(info);

  const description = buildDescription(info, item, detail, provider);

  const onset = first(info?.onset, data?.startDate, item?.startDate);
  const effective = first(info?.effective, item?.sent, data?.sent);
  const expires = first(info?.expires, data?.expires, item?.expires);

  const sent = first(detail?.sent, item?.sent, data?.sent);

  const severity = first(info?.severity, data?.severity, item?.severity);

  const publisher = first(
    detail?.sender,
    data?.provider,
    item?.provider
  );

  return {
    source_event_id: String(item.id),

    publisher: publisher
      ? `NINA / ${String(publisher)}`
      : 'NINA / BBK',

    title,
    description,

    category: classify(title, event, categories, provider),

    source_url: officialUrl(item.id),

    latitude: null,
    longitude: null,
    geo_precision: 'city',
    location_name: CITY.name,

    // CAP onset — начало предполагаемого события.
    // effective — начало действия предупреждения.
    event_time: iso(first(onset, effective)),
    time_precision: first(onset, effective) ? 'exact' : 'unknown',

    published_at: iso(sent),

    status: 'ACTIVE',
    status_reason: 'listed_in_current_source_feed',

    confidence: 0.95,
    is_verified: 1,

    severity: severity ? String(severity) : null,
    expires_at: iso(expires)
  };
}

// -------------------- concurrent requests --------------------

async function fetchDetail(id) {
  try {
    const { json } = await fetchJson(detailUrl(id));
    return json || null;
  } catch (error) {
    console.warn(
      `[nina] detail ${id}: ${error?.message || String(error)}`
    );
    return null;
  }
}

async function mapConcurrent(items, concurrency, fn) {
  const result = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      result[index] = await fn(items[index], index);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      () => worker()
    )
  );

  return result;
}

// -------------------- source run --------------------

export async function run(ctx) {
  const u = dashboardUrl(ctx.env);
  const { json } = await fetchJson(u);

  // Dashboard должен быть массивом. При неожиданной структуре
  // нельзя синхронизировать пустой список и завершить все предупреждения.
  if (!Array.isArray(json)) {
    throw new Error(
      `NINA dashboard: ожидался массив, получено ${typeof json}`
    );
  }

  const candidates = json.filter((item) =>
    item &&
    typeof item === 'object' &&
    item.id != null
  );

  const normalized = await mapConcurrent(
    candidates,
    DETAIL_CONCURRENCY,
    async (item) => {
      const detail = await fetchDetail(item.id);

      // Если detail недоступен, dashboard всё равно сохраняется.
      return toItem(item, detail);
    }
  );

  const items = normalized.filter(Boolean);

  console.log(
    `[nina] dashboard=${json.length}, ` +
    `candidates=${candidates.length}, ` +
    `normalized=${items.length}`
  );

  return syncSource(ctx, meta.id, items, {
    resolveMissing: true,
    resolvedScopes: null,
    scope: null
  });
}

// -------------------- probe --------------------

export async function probe(ctx) {
  const u = dashboardUrl(ctx.env);
  const { json, text } = await fetchJson(u);

  const list = Array.isArray(json) ? json : [];
  const firstItem = list.find((item) => item?.id);

  let detail = null;

  if (firstItem) {
    detail = await fetchDetail(firstItem.id);
  }

  return {
    url: u,
    count: list.length,
    dashboard_sample: list.slice(0, 2),
    detail_url: firstItem ? detailUrl(firstItem.id) : null,
    detail_sample: detail,
    geojson_url: firstItem ? geoJsonUrl(firstItem.id) : null,
    raw: text.slice(0, 3000)
  };
}
