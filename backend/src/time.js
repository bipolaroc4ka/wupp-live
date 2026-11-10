// Разбор времени происшествия из текста пресс-релиза.
// Принцип: время ПРОИСШЕСТВИЯ берётся только из явных указаний в тексте.
// Если однозначно определить нельзя — возвращается "unknown". Время публикации НИКОГДА не подставляется.

const TZ = 'Europe/Berlin';
const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit'
});

function partsAt(ms) {
  const o = {};
  for (const p of fmt.formatToParts(new Date(ms))) o[p.type] = p.value;
  return o;
}

export function berlinOffsetMin(utcMs) {
  const p = partsAt(utcMs);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}

// Локальное берлинское время -> UTC миллисекунды (учитывает летнее/зимнее время).
export function berlinToUtc(y, mo, d, h = 0, mi = 0) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off = berlinOffsetMin(guess);
  let t = guess - off * 60000;
  const off2 = berlinOffsetMin(t);
  if (off2 !== off) t = guess - off2 * 60000;
  return t;
}

export function berlinYMD(ms) {
  const p = partsAt(ms);
  return { y: +p.year, m: +p.month, d: +p.day };
}

const MONTHS = {
  januar: 1, februar: 2, märz: 3, maerz: 3, april: 4, mai: 5, juni: 6, juli: 7,
  august: 8, september: 9, oktober: 10, november: 11, dezember: 12
};
const WEEKDAYS = { sonntag: 0, montag: 1, dienstag: 2, mittwoch: 3, donnerstag: 4, freitag: 5, samstag: 6 };

function addDays({ y, m, d }, delta) {
  const t = new Date(Date.UTC(y, m - 1, d + delta));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function validDate(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export function parseEventTime(text, publishedMs) {
  const unknown = { ms: null, precision: 'unknown' };
  if (!text || !Number.isFinite(publishedMs)) return unknown;
  const pub = berlinYMD(publishedMs);
  let date = null;

  // 1) Явная дата: 27.09.2026 / 30.08. / 19. September 2026
  let m = text.match(/\b(\d{1,2})\.(\d{1,2})\.?(?:\s?(\d{4}))?(?!\d)(?!\s*Uhr)/);
  if (m && +m[1] >= 1 && +m[1] <= 31 && +m[2] >= 1 && +m[2] <= 12) {
    date = { d: +m[1], m: +m[2], y: m[3] ? +m[3] : null };
  }
  if (!date) {
    const mm = text.match(/\b(\d{1,2})\.\s*(januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember)\w*\s*(\d{4})?/i);
    if (mm && +mm[1] >= 1 && +mm[1] <= 31) {
      date = { d: +mm[1], m: MONTHS[mm[2].toLowerCase()], y: mm[3] ? +mm[3] : null };
    }
  }
  if (date) {
    let y = date.y ?? pub.y;
    if (!validDate(y, date.m, date.d)) return unknown;
    if (date.y == null && berlinToUtc(y, date.m, date.d, 12, 0) > publishedMs + 36 * 3600e3) y -= 1;
    if (!validDate(y, date.m, date.d)) return unknown;
    date = { y, m: date.m, d: date.d };
  }

  // 2) Относительные слова: вчера / сегодня / день недели
  if (!date) {
    if (/\bvorgestern\b/i.test(text)) date = addDays(pub, -2);
    else if (/\bgestern\b/i.test(text)) date = addDays(pub, -1);
    else if (/\bheut\w*/i.test(text)) date = addDays(pub, 0);
    else {
      const w = text.match(/\b(sonntag|montag|dienstag|mittwoch|donnerstag|freitag|samstag)\w*/i);
      if (w) {
        const target = WEEKDAYS[w[1].toLowerCase()];
        const pubWd = new Date(Date.UTC(pub.y, pub.m - 1, pub.d)).getUTCDay();
        const diff = (pubWd - target + 7) % 7;
        if (diff !== 0) date = addDays(pub, -diff); // тот же день недели — неоднозначно, не угадываем
      }
    }
  }
  if (!date) return unknown;

  // 3) Время суток
  let h = null, mi = 0;
  const tm = text.match(/\b(\d{1,2})[:.](\d{2})\s*Uhr/);
  if (tm && +tm[1] < 24 && +tm[2] < 60) { h = +tm[1]; mi = +tm[2]; }
  else {
    const t2 = text.match(/\b(?:um|gegen|ab)\s+(\d{1,2})\s*Uhr/i);
    if (t2 && +t2[1] < 24) { h = +t2[1]; mi = 0; }
  }

  const ms = berlinToUtc(date.y, date.m, date.d, h ?? 0, mi);
  if (ms > publishedMs + 10 * 60000) return unknown;      // «событие в будущем» — ошибка разбора
  if (ms < publishedMs - 45 * 24 * 3600e3) return unknown; // слишком давно — не уверены
  return { ms, precision: h == null ? 'day' : 'minute' };
}
