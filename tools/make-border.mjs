// Скачивает официальную границу города Wuppertal из OpenStreetMap (Nominatim), упрощает и пишет frontend/js/city-border.js.
// Запуск из папки tools:  node make-border.mjs   (Node 18+). Один запрос, ничего не меняет, кроме выходного файла.
// Данные © OpenStreetMap contributors (ODbL), как и сама карта.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'frontend', 'js', 'city-border.js');
const URL_Q = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
  q: 'Wuppertal, Nordrhein-Westfalen, Deutschland', format: 'jsonv2', polygon_geojson: '1', polygon_threshold: '0.0002', limit: '5', countrycodes: 'de'
});
// Для проверки без сети: BORDER_FIXTURE=файл.json (ответ Nominatim) вместо запроса
let list;
if (process.env.BORDER_FIXTURE) list = JSON.parse((await import('node:fs')).readFileSync(process.env.BORDER_FIXTURE, 'utf8'));
else {
  const res = await fetch(URL_Q, { headers: { 'user-agent': 'WuppertalLive-border/1.0 (one-time boundary download)', 'accept-language': 'de' } });
  if (!res.ok) { console.error('Nominatim HTTP', res.status); process.exit(1); }
  list = await res.json();
}
const hit = list.find((r) => r.category === 'boundary' && r.type === 'administrative' && r.geojson && /Polygon/.test(r.geojson.type));
if (!hit) { console.error('Граница не найдена. Результаты:', list.map((r) => `${r.category}/${r.type} ${r.display_name}`)); process.exit(1); }
console.log('Найдено:', hit.display_name, `(${hit.geojson.type})`);

// Douglas-Peucker: убираем лишние точки (допуск ~25 м), чтобы файл был небольшим
const tol = 0.00025;
function dp(pts, t) {
  if (pts.length < 3) return pts;
  const [x1, y1] = pts[0], [x2, y2] = pts[pts.length - 1];
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1e-12;
  let max = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + x2 * y1 - y2 * x1) / len;
    if (d > max) { max = d; idx = i; }
  }
  if (max <= t) return [pts[0], pts[pts.length - 1]];
  return [...dp(pts.slice(0, idx + 1), t).slice(0, -1), ...dp(pts.slice(idx), t)];
}
const round = (p) => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5];
const polys = hit.geojson.type === 'Polygon' ? [hit.geojson.coordinates] : hit.geojson.coordinates;
function ring(r) { // замкнутое кольцо: первая и последняя точки совпадают, поэтому делим его пополам
  if (r.length < 5) return r;
  let m = 1, far = -1;
  for (let i = 1; i < r.length - 1; i++) { const d = Math.hypot(r[i][0] - r[0][0], r[i][1] - r[0][1]); if (d > far) { far = d; m = i; } }
  return [...dp(r.slice(0, m + 1), tol).slice(0, -1), ...dp(r.slice(m), tol)];
}
const outer = polys.map((p) => ring(p[0]).map(round)).filter((r) => r.length > 3);
if (!outer.length) { console.error('После упрощения не осталось ни одного кольца, файл не записан.'); process.exit(1); }
const geo = { type: 'MultiPolygon', coordinates: outer.map((r) => [r]) };
const pts = outer.reduce((n, r) => n + r.length, 0);
const lons = outer.flat().map((p) => p[0]), lats = outer.flat().map((p) => p[1]);
console.log(`Колец: ${outer.length}, точек: ${pts}; широта ${Math.min(...lats)}..${Math.max(...lats)}, долгота ${Math.min(...lons)}..${Math.max(...lons)}`);
if (Math.min(...lats) < 51.0 || Math.max(...lats) > 51.5 || Math.min(...lons) < 6.9 || Math.max(...lons) > 7.4) { console.error('Границы вне ожидаемой области Wuppertal, файл не записан.'); process.exit(1); }
writeFileSync(OUT, `// Граница города Wuppertal (OpenStreetMap, © OpenStreetMap contributors, ODbL). Создано tools/make-border.mjs.\nwindow.WL_BORDER = ${JSON.stringify(geo)};\n`);
console.log('Записано:', OUT);
