// Описания Autobahn и Mobidrom — это строки «Подпись: значение». Подписи и числовые значения (даты, длины, единицы)
// переводятся по правилам, без языковой модели: так перевод точный, а названия не искажаются.
// Свободный текст (вид работ, примечания) отдаётся переводчику через переданную функцию.

const LABELS = {
  'Richtung': ['Направление', 'raw'],
  'Zeiträume': ['Периоды работ', 'dates'],
  'Bauphase': ['Этап работ', 'dates'],
  'Gesamtmaßnahme bis': ['Весь проект до', 'dates'],
  'Abschnitt': ['Участок', 'section'],
  'Länge': ['Протяжённость', 'units'],
  'Tempolimit': ['Ограничение скорости', 'units'],
  'Max. Durchfahrtsbreite': ['Макс. ширина проезда', 'units'],
  'Maßnahme': ['Работы', 'text'],
  'Meldung': ['Сообщение', 'text'],
  'Hinweis': ['Примечание', 'text'],
  'Art der Arbeiten': ['Вид работ', 'text'],
  'Ort': ['Место', 'raw'],
  'Lage': ['Положение', 'raw'],
  'Bauzeit': ['Срок работ', 'dates'],
  'Zeitfenster': ['Время работ', 'window'],
  'Fahrstreifen': ['Полосы', 'lanes'],
  'Umleitung': ['Объезд', 'route']
};

const DAYS = { Mo: 'Пн', Di: 'Вт', Mi: 'Ср', Do: 'Чт', Fr: 'Пт', Sa: 'Сб', So: 'Вс' };

const units = (v) => v.replace(/\bkm\/h\b/g, 'км/ч').replace(/\bkm\b/g, 'км').replace(/(\d)\s*m\b/g, '$1 м');
const dates = (v) => v.replace(/^seit\s+/i, 'с ').replace(/^bis\s+/i, 'до ');

const conv = (part) => part
  .replace(/^(\d+(?:,\d+)?)\s*km hinter\s+/, '$1 км после ')
  .replace(/^(\d+(?:,\d+)?)\s*km vor\s+/, '$1 км до ');

function section(v) {
  let out = v
    .replace(/^Auffahrt auf die (A\d+):/, 'Въезд на $1:')
    .replace(/^Abfahrt von der (A\d+):/, 'Съезд с $1:')
    .replace(/^Ausfahrt aus der (A\d+):/, 'Съезд с $1:')
    .replace(/\(aus Richtung ([^)]+)\)/g, '(со стороны $1)')
    .replace(/\(in Richtung ([^)]+)\)/g, '(в направлении $1)');
  out = out.replace(/zwischen\s+(.+?)\s+und\s+(.+?)(?=$|;)/g, (m, a, b) => `между ${conv(a)} и ${conv(b)}`);
  return units(out);
}

const route = (v) => v
  .replace(/\bfür Fahrzeuge\b/gi, 'для транспорта')
  .replace(/\b[Üü]ber\b/g, 'через')
  .replace(/\bRichtung\b/g, 'в направлении')
  .replace(/\bund\b/g, 'и');

const lanes = (v) => v
  .replace(/(\d+) eingeschränkt/, 'ограничено полос: $1')
  .replace(/(\d+) befahrbar/, 'свободно полос: $1');

const windowDays = (v) => v.replace(/\b(Mo|Di|Mi|Do|Fr|Sa|So)\b/g, (d) => DAYS[d]);

/**
 * Русская версия описания из строк «Подпись: значение».
 * Возвращает null, если ни одной известной подписи нет (тогда используется обычный перевод).
 * translateText(value) — перевод свободного текста.
 */
export async function translateStructured(description, translateText) {
  const lines = String(description || '').split('\n');
  const parsed = lines.map((line) => {
    const m = /^([^:\n]{2,40}):\s*(.*)$/.exec(line);
    return m && LABELS[m[1]] ? { label: m[1], value: m[2] } : { raw: line };
  });
  if (!parsed.some((p) => p.label)) return null;

  const out = [];
  for (const p of parsed) {
    if (!p.label) { out.push(p.raw && p.raw.trim() ? await translateText(p.raw) : p.raw); continue; }
    const [ru, kind] = LABELS[p.label];
    let value = p.value;
    if (kind === 'dates') value = dates(value);
    else if (kind === 'units') value = units(value);
    else if (kind === 'section') value = section(value);
    else if (kind === 'route') value = route(value);
    else if (kind === 'lanes') value = lanes(value);
    else if (kind === 'window') value = windowDays(value);
    else if (kind === 'text') value = value ? await translateText(value) : value;
    out.push(`${ru}: ${value}`);
  }
  return out.join('\n');
}
