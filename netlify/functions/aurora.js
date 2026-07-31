/* ─────────────────────────────────────────────
   Aurora — Netlify serverless function
   Endpoints (deployed at /api/*):
     POST /api/content   { urls: [...] } -> { ok, results: { url: text|null } }
     GET  /api/search?q=  (optional, needs BRAVE_API_KEY)
     GET  /api/health
   CORS-enabled so the static site can call it.
   ───────────────────────────────────────────── */
const CACHE_TTL = 10 * 60 * 1000;        // 10 min
const MAX_RESULTS = 8;
const MAX_PAGE_BYTES = 1.5 * 1024 * 1024; // 1.5 MB
const MAX_TEXT = 8000;                    // chars kept per article
const FETCH_TIMEOUT = 12000;

const cache = new Map(); // url -> { text, ts }

// ── helpers ──
function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…');
}

function stripTags(html) {
  let h = String(html || '');
  // drop script/style/nav/comment noise
  h = h
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(nav|aside|footer|form|iframe|svg|button|select|input)[\s>][\s\S]*?<\/\1>/gi, ' ');

  // prefer the main article body if present
  const main = h.match(/<article[\s\S]*?<\/article>/i) || h.match(/<main[\s\S]*?<\/main>/i);
  if (main) h = main[0];

  // keep headings & paragraphs, drop everything else
  h = h
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, '\n\n$2\n')
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n• $1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  return decodeEntities(h)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AuroraResearch/1.0; research assistant)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    return res;
  } finally {
    clearTimeout(t);
  }
}

async function fetchArticleText(url) {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.text;

  const res = await fetchWithTimeout(url, FETCH_TIMEOUT);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_PAGE_BYTES) throw new Error('Page too large');
  const html = buf.toString('utf8');
  const text = stripTags(html).slice(0, MAX_TEXT);
  if (text.length < 60) throw new Error('No readable content');

  if (cache.size > 300) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(url, { text, ts: Date.now() });
  return text;
}

// ── optional Brave Search proxy (needs BRAVE_API_KEY env) ──
async function braveSearch(q) {
  const key = process.env.BRAVE_API_KEY;
  if (!key) throw new Error('BRAVE_API_KEY not configured');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=8&search_lang=en&country=us`,
      { headers: { 'Accept': 'application/json', 'X-Subscription-Token': key }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`Brave error ${res.status}`);
    const data = await res.json();
    return (data.web && data.web.results || []).map(r => ({
      id: 'brave-' + r.url,
      source: 'web',
      title: r.title,
      url: r.url,
      snippet: (r.description || '').slice(0, 300),
      publishedAt: r.age ? Date.now() - parseAge(r.age) : null,
      meta: r.profile && r.profile.name,
    }));
  } finally {
    clearTimeout(t);
  }
}

function parseAge(age) {
  const m = age.match(/(\d+)\s*(hour|day|week|month|year)s?/i);
  if (!m) return 0;
  const n = Number(m[1]);
  const units = { hour: 36e5, day: 864e5, week: 6048e5, month: 26298e5, year: 31557e6 };
  return n * (units[m[2].toLowerCase()] || 0);
}

// ── keyless web search: SearXNG public instances → DuckDuckGo HTML ──
// Public SearXNG instances rotate and rate-limit, so we try several in parallel
// (first to return real results wins), then fall back to DuckDuckGo's HTML
// endpoint which needs no key and works from any server IP.
const SEARXNG_INSTANCES = [
  'https://searx.be',
  'https://search.hbubli.cc',
  'https://opnxng.com',
  'https://searx.tiekoetter.com',
  'https://priv.au',
  'https://searx.work',
];

async function searxngSearch(base, q) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 7000);
  try {
    const res = await fetch(`${base}/search?q=${encodeURIComponent(q)}&format=json&language=en&safesearch=0`, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; AuroraResearch/1.0)' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const items = (data.results || []).slice(0, 8).map((r, i) => ({
      id: 'sx-' + (r.url || i),
      source: 'web',
      title: r.title || 'Web result',
      url: r.url || '',
      snippet: String(r.content || '').replace(/<[^>]+>/g, '').slice(0, 300),
      publishedAt: r.publishedDate ? new Date(r.publishedDate).getTime() : null,
      meta: Array.isArray(r.engine) ? r.engine[0] : (r.engine || 'SearXNG'),
    }));
    if (!items.length) throw new Error('No results');
    return items;
  } finally {
    clearTimeout(t);
  }
}

// Parse DuckDuckGo's HTML results page (server-side, no key needed).
// Real DDG structure (2026): within each <div class="result ..."> there's a
//   <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=...&amp;rut=...">Title</a></h2>
//   <div class="result__extras">...</div>
//   <a class="result__snippet" href="...">Snippet</a>
// The snippet comes AFTER the extras div, so we extract the two anchor types
// independently (DDG emits one of each per result, in order) and zip by index.
function parseDdgHtml(html) {
  const htmlStr = String(html || '');
  const aRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const sRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  const links = [];
  let m;
  while ((m = aRe.exec(htmlStr)) && links.length < 8) {
    links.push(m);
  }
  const snippets = [];
  while ((m = sRe.exec(htmlStr)) && snippets.length < 8) {
    snippets.push(m[1]);
  }

  const items = links.map((a, i) => {
    let url = decodeEntities(a[1]); // turns &amp; → & so uddg regex stops at the rut= separator
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) {
      try { url = decodeURIComponent(uddg[1]); } catch { /* keep raw */ }
    } else if (url.startsWith('//')) {
      url = 'https:' + url;
    }
    return {
      id: 'ddg-' + i,
      source: 'web',
      title: stripTags(a[2]).trim() || 'Web result',
      url,
      snippet: (snippets[i] ? stripTags(snippets[i]) : '').trim().slice(0, 300),
      publishedAt: null,
      meta: 'DuckDuckGo',
    };
  });
  return items;
}

async function duckDuckGoHtml(q) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AuroraResearch/1.0)' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`DDG HTTP ${res.status}`);
    const html = await res.text();
    const items = parseDdgHtml(html);
    if (!items.length) throw new Error('No DDG results');
    return items;
  } finally {
    clearTimeout(t);
  }
}

// Keyless-first web search: Brave (if key set) → SearXNG (parallel) → DDG HTML
async function webSearch(q) {
  // 1. Brave if a key is configured (best quality)
  if (process.env.BRAVE_API_KEY) {
    try {
      const items = await braveSearch(q);
      if (items.length) return { items, engine: 'brave' };
    } catch { /* fall through */ }
  }
  // 2. SearXNG public instances in parallel — first success wins
  try {
    const items = await Promise.any(SEARXNG_INSTANCES.map(base => searxngSearch(base, q)));
    return { items, engine: 'searxng' };
  } catch { /* fall through */ }
  // 3. DuckDuckGo HTML (always available, keyless)
  const items = await duckDuckGoHtml(q);
  return { items, engine: 'duckduckgo' };
}

// ── handler ──
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  try {
    const url = new URL(event.rawUrl || `https://x${event.path}`);

    // health
    if (event.httpMethod === 'GET' && url.pathname.endsWith('/health')) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, cache: cache.size }) };
    }

    // web search proxy (keyless-first: SearXNG → DDG, Brave if key set)
    if (event.httpMethod === 'GET' && url.pathname.endsWith('/search')) {
      const q = url.searchParams.get('q') || '';
      if (!q) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'missing q' }) };
      const { items, engine } = await webSearch(q);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, results: items, engine }) };
    }

    // content extraction
    if (event.httpMethod === 'POST' && url.pathname.endsWith('/content')) {
      const body = JSON.parse(event.body || '{}');
      const urls = (body.urls || [])
        .filter(u => typeof u === 'string' && /^https?:\/\//.test(u))
        .slice(0, MAX_RESULTS);
      if (!urls.length) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'no urls' }) };

      const results = {};
      await Promise.all(urls.map(async u => {
        try { results[u] = await fetchArticleText(u); }
        catch { results[u] = null; }
      }));
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, results }) };
    }

    return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: 'not found' }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

// exported for unit tests
exports._stripTags = stripTags;
exports._decodeEntities = decodeEntities;
exports._parseDdgHtml = parseDdgHtml;
