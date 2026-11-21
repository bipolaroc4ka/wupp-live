// Проба 3: что в WSW_Netz_Marker.js кроме контура города: маркеры/полигоны störungen, popup-тексты, даты.
// Запуск: node probe-netz3.mjs (Node 18+). Только чтение. Пришлите вывод целиком.
const r = await fetch('https://www.wsw-netz.de/fileadmin/leaflet/WSW_Netz_Marker.js?version=v2', { headers: { 'user-agent': 'WuppertalLive-probe/1.0' }, signal: AbortSignal.timeout(20000) });
const t = await r.text();
console.log(r.status, t.length, 'байт; last-modified:', r.headers.get('last-modified'), '| etag:', r.headers.get('etag'), '| cache-control:', r.headers.get('cache-control'));
const lines = t.split(/\r?\n/);
console.log('строк:', lines.length);
const short = lines.map((l, i) => [i + 1, l]).filter(([, l]) => l.length < 400 && l.trim());
console.log('\n--- все короткие строки (без массивов координат), первые 120 ---');
short.slice(0, 120).forEach(([i, l]) => console.log(i + ':', l.trim().slice(0, 300)));
const kw = /L\.(marker|circle|circleMarker|polygon|polyline|geoJSON|icon|divIcon)|bindPopup|bindTooltip|fetch\(|XMLHttpRequest|\$\.(get|ajax|getJSON)/g;
const cnt = {}; for (const m of t.matchAll(kw)) cnt[m[0]] = (cnt[m[0]] || 0) + 1;
console.log('\nвызовы Leaflet/сети:', JSON.stringify(cnt));
console.log('\n--- последние 2500 символов ---\n' + t.slice(-2500));
console.log('\nГотово.');
