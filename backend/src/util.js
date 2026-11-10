// Общие утилиты: хэши, ожидание, fetch с таймаутом и повторными попытками.

export const ISO = (ms) => new Date(ms).toISOString();

export async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function shortId(str) {
  return (await sha256Hex(str)).slice(0, 16);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Секреты не должны попадать ни в логи, ни в сообщения об ошибках.
export function redactUrl(u) {
  return String(u).replace(/(api_key|apikey|key|token)=[^&]+/gi, '$1=***');
}

export async function fetchWithRetry(url, { headers = {}, timeoutMs = 8000, retries = 2, backoffMs = 600 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers, signal: ctrl.signal });
      clearTimeout(timer);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status} for ${redactUrl(url)}`);
      } else {
        return res;
      }
    } catch (e) {
      clearTimeout(timer);
      lastErr = new Error(`${e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || 'network error'} for ${redactUrl(url)}`);
    }
    if (attempt < retries) await sleep(backoffMs * (attempt + 1));
  }
  throw lastErr;
}

export async function fetchJson(url, opts = {}) {
  const res = await fetchWithRetry(url, {
    ...opts,
    headers: { accept: 'application/json', ...(opts.headers || {}) }
  });
  if (res.status === 204) return { status: 204, json: null, text: '' };
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${redactUrl(url)}`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${redactUrl(url)}`);
  }
  return { status: res.status, json, text };
}

export function truncate(s, n) {
  s = String(s ?? '');
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(' ');
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + '…';
}
