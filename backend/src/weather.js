// Погода для карты: данные Deutscher Wetterdienst (DWD) через Bright Sky (https://brightsky.dev, без ключа).
// Текущие значения — измерения ближайшей станции; если их нет, берётся ближайший час прогноза с пометкой from: 'forecast'.
// Ответ кэшируется в index.js на 10 минут, так что внешний API получает не больше ~2 запросов за 10 минут.
import { CITY } from './config.js';
import { fetchWithRetry } from './util.js';

const BASE = 'https://api.brightsky.dev';
const LAT = 51.2562, LON = 7.1508; // центр Wuppertal
const ICONS = new Set(['clear-day', 'clear-night', 'partly-cloudy-day', 'partly-cloudy-night', 'cloudy', 'fog', 'wind', 'rain', 'sleet', 'snow', 'hail', 'thunderstorm']);

const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi) ? v : null;
const round = (v, d = 0) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const icon = (v) => (ICONS.has(v) ? v : null);

// Приводит запись Bright Sky к нашему формату; значения вне разумных пределов отбрасываются (null), а не выдумываются.
export function normalizeRecord(w) {
  if (!w || typeof w !== 'object') return null;
  const t = Date.parse(w.timestamp);
  if (!Number.isFinite(t)) return null;
  return {
    t: new Date(t).toISOString(),
    temp: round(num(w.temperature, -60, 60), 1),
    icon: icon(w.icon),
    wind_kmh: round(num(w.wind_speed_10 ?? w.wind_speed, 0, 400)),
    gust_kmh: round(num(w.wind_gust_speed_10 ?? w.wind_gust_speed, 0, 500)),
    wind_dir: round(num(w.wind_direction_10 ?? w.wind_direction, 0, 360)),
    humidity: round(num(w.relative_humidity, 0, 100)),
    precip_mm: round(num(w.precipitation_60 ?? w.precipitation, 0, 500), 1),
    precip_prob: round(num(w.precipitation_probability, 0, 100)),
    pressure: round(num(w.pressure_msl, 800, 1100)),
    cloud: round(num(w.cloud_cover, 0, 100))
  };
}

async function getJson(url) {
  const res = await fetchWithRetry(url, { timeoutMs: 8000, retries: 1, headers: { accept: 'application/json', 'user-agent': 'WuppertalLive/1.0' } });
  if (!res.ok) throw new Error(`Bright Sky HTTP ${res.status}`);
  return res.json();
}

// Часы прогноза: от ближайшего «сейчас» и далее (не более n)
export function pickForecast(records, nowMs, n = 6) {
  return records
    .map(normalizeRecord)
    .filter((r) => r && r.temp != null && Date.parse(r.t) >= nowMs - 30 * 60000)
    .sort((a, b) => a.t.localeCompare(b.t))
    .slice(0, n);
}

export async function fetchWeather(now = Date.now()) {
  const day = (ms) => new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  const common = `lat=${LAT}&lon=${LON}&tz=Europe%2FBerlin&units=dwd`;
  const [cur, fc] = await Promise.allSettled([
    getJson(`${BASE}/current_weather?${common}`),
    getJson(`${BASE}/weather?${common}&date=${day(now)}&last_date=${day(now + 2 * 86400e3)}`)
  ]);

  let current = null, from = null, station = null;
  if (cur.status === 'fulfilled' && cur.value && cur.value.weather) {
    const c = normalizeRecord(cur.value.weather);
    if (c && c.temp != null && now - Date.parse(c.t) < 3 * 3600e3 && Date.parse(c.t) <= now + 10 * 60000) {
      current = c; from = 'observation';
      const src = Array.isArray(cur.value.sources) ? cur.value.sources[0] : null;
      if (src && typeof src.station_name === 'string') station = { name: src.station_name.slice(0, 60), distance_km: round(num(src.distance, 0, 100000) / 1000, 0) };
    }
  }
  const forecast = fc.status === 'fulfilled' && fc.value && Array.isArray(fc.value.weather) ? pickForecast(fc.value.weather, now, 8) : [];
  if (!current && forecast.length) { current = forecast[0]; from = 'forecast'; }
  if (!current) throw new Error('weather unavailable');

  return {
    generated_at: new Date(now).toISOString(),
    city: CITY.name,
    from,
    station,
    current,
    forecast: forecast.filter((f) => f.t !== current.t).slice(0, 6),
    attribution: 'Deutscher Wetterdienst (DWD) via Bright Sky'
  };
}
