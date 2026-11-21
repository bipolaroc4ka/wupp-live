// Вид карты «Wupper»: тайлы OpenStreetMap перекрашиваются в canvas (по пикселям), а не CSS/SVG-фильтрами.
// Так результат одинаков в браузере и в WebView Telegram (iOS/Android/Desktop), где SVG-фильтры на карте работают нестабильно.
// Если сервер тайлов не разрешает чтение пикселей (CORS), показываем обычные тайлы и просим CSS-запасной вариант (data-tintfail).
window.WL_MAPSTYLE = (() => {
  // Параметры подобраны под цвета стандартного слоя OSM (земля #f2efe9, дороги, вода, парки)
  const LAND = [242, 239, 233];
  const NIGHT = { k: 1.4, p: 0.55, sat: 0.58, m: [[-1.0281, 0.5628, 0.838], [1.2016, 0.0302, 1.1804], [0.6708, 0.2643, -1.127], [0.0406, 0.069, 0.2148]] };
  const DAY = { sat: 0.7, m: [[1.7474, -0.1373, -0.4565], [0.0352, 1.2521, -0.1429], [-0.6939, -0.0229, 1.433], [-0.158, -0.0967, 0.2265]] };

  // таблица |x - земля|^p для каждого канала (256 значений)
  const lut = LAND.map((l) => {
    const t = new Float32Array(256);
    for (let i = 0; i < 256; i++) t[i] = Math.min(1, Math.abs(i - l) / 255 * NIGHT.k) ** NIGHT.p;
    return t;
  });
  const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  function tint(px, theme) {
    const night = theme === 'dark';
    const P = night ? NIGHT : DAY, m = P.m, s = P.sat;
    for (let i = 0; i < px.length; i += 4) {
      let a, b, c;
      if (night) { a = lut[0][px[i]]; b = lut[1][px[i + 1]]; c = lut[2][px[i + 2]]; }
      else { a = px[i] / 255; b = px[i + 1] / 255; c = px[i + 2] / 255; }
      let r = clamp(m[0][0] * a + m[1][0] * b + m[2][0] * c + m[3][0]);
      let g = clamp(m[0][1] * a + m[1][1] * b + m[2][1] * c + m[3][1]);
      let bl = clamp(m[0][2] * a + m[1][2] * b + m[2][2] * c + m[3][2]);
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
      px[i] = clamp(y + s * (r - y)) * 255;
      px[i + 1] = clamp(y + s * (g - y)) * 255;
      px[i + 2] = clamp(y + s * (bl - y)) * 255;
    }
  }

  // Слой тайлов. getState() -> { style: 'wupper' | 'classic', theme: 'dark' | 'light' }; onFail() вызывается, если пиксели читать нельзя.
  function layer(L, url, options, getState, onFail) {
    if (!L.TileLayer || !L.TileLayer.extend) return L.tileLayer(url, options);
    const Tiles = L.TileLayer.extend({
      createTile(coords, done) {
        const st = getState();
        if (st.style !== 'wupper') return L.TileLayer.prototype.createTile.call(this, coords, done);
        const size = this.getTileSize();
        const tile = L.DomUtil.create('canvas', 'leaflet-tile');
        tile.width = size.x; tile.height = size.y;
        tile.setAttribute('role', 'presentation');
        const draw = (img, canRead) => {
          const ctx = tile.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, size.x, size.y);
          if (canRead) {
            try { const d = ctx.getImageData(0, 0, size.x, size.y); tint(d.data, st.theme); ctx.putImageData(d, 0, 0); } catch { if (onFail) onFail(); }
          }
          done(null, tile);
        };
        const load = (cors) => {
          const img = new Image();
          if (cors) img.crossOrigin = 'anonymous';
          img.onload = () => {
            if (!cors && !this._noCors) { this._noCors = true; if (onFail) onFail(); } // без CORS тайл грузится, значит дело в CORS, а не в сети
            draw(img, cors);
          };
          img.onerror = () => { if (cors && !this._noCors) load(false); else done(new Error('tile'), tile); };
          img.src = this.getTileUrl(coords);
        };
        load(!this._noCors);
        return tile;
      }
    });
    return new Tiles(url, options);
  }
  return { layer, tint };
})();
