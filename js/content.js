/* ─────────────────────────────────────────────
   Aurora — full-content reader
   Calls the serverless backend (/api/content) to fetch
   full article text for richer RAG reports. Falls back
   gracefully to snippets when the backend isn't deployed
   (e.g. static hosting or local dev without functions).
   ───────────────────────────────────────────── */
const Content = (() => {
  const ENDPOINT = '/api/content';
  const SUMMARY_ENDPOINT = '/api/summarize';
  const MAX_URLS = 12;
  const TIMEOUT = 15000;

  async function fetchWithTimeout(url, opts = {}, ms = TIMEOUT) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, { ...opts, signal: ctrl.signal });
    } finally {
      clearTimeout(t);
    }
  }

  // Returns { url: text } for the articles we could read, or null if unavailable.
  async function readArticles(urls) {
    const list = (urls || []).filter(u => /^https?:\/\//.test(u)).slice(0, MAX_URLS);
    if (!list.length) return null;
    try {
      const res = await fetchWithTimeout(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: list }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data.ok || !data.results) return null;
      const map = {};
      for (const [u, text] of Object.entries(data.results)) {
        if (text) map[u] = text;
      }
      return Object.keys(map).length ? map : null;
    } catch {
      return null; // backend not deployed / offline — callers fall back to snippets
    }
  }

  // Quick probe — used to show backend status in Settings.
  async function isAvailable() {
    try {
      const res = await fetchWithTimeout(ENDPOINT + '/health', {}, 4000);
      return res.ok;
    } catch {
      return false;
    }
  }

  // Scrape one article and get an elegant spoken-word summary (server-side AI).
  // Returns { summary, engine } or null when the article is unreadable/backend down.
  async function summarizeArticle(url, title) {
    if (!/^https?:\/\//.test(url || '')) return null;
    try {
      const res = await fetchWithTimeout(SUMMARY_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, title: title || '' }),
      }, 32000); // server function timeout is 30s — fail fast and fall back
      if (!res.ok) return null;
      const data = await res.json();
      return data && data.ok && data.summary ? { summary: data.summary, engine: data.engine || 'extractive' } : null;
    } catch {
      return null;
    }
  }

  return { readArticles, summarizeArticle, isAvailable };
})();
