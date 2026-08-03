/* ─────────────────────────────────────────────
   Aurora — Netlify serverless function
   Endpoints (deployed at /api/*):
     POST /api/content   { urls: [...] } -> { ok, results: { url: text|null } }
     GET  /api/search?q=  (optional, needs BRAVE_API_KEY)
     POST /api/tts        { text, voice, speed } -> audio/mpeg (free Edge TTS narrator)
     GET  /api/tts/voices -> { voices: [...] } (free neural voices, no key)
     GET  /api/tts/status -> { ok, configured }
     GET  /api/health
   CORS-enabled so the static site can call it.
   ───────────────────────────────────────────── */
const crypto = require('crypto');
const { EdgeTTS } = require('edge-tts-universal');

const CACHE_TTL = 10 * 60 * 1000;        // 10 min
const MAX_RESULTS = 12;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;  // 2 MB (headroom for live blogs / Wikipedia)
const MAX_TEXT = 20000;                   // chars kept per article (long articles → richer summaries)
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

// Grab the balanced <div>…</div> (or <article>…</article>) region starting at the
// first match of `openRe`. A lazy `[\s\S]*?<\/div>` would stop at the FIRST nested
// `</div>`, truncating the article — this counts nesting so we get the real container.
function grabBalanced(html, openRe) {
  const open = html.match(openRe);
  if (!open) return null;
  const start = open.index + open[0].length;
  let depth = 1;
  let i = start;
  while (i < html.length && depth > 0) {
    const openIdx = html.indexOf('<div', i);
    const closeIdx = html.indexOf('</div', i);
    if (closeIdx === -1) { depth = 0; break; }
    if (openIdx !== -1 && openIdx < closeIdx) { depth++; i = openIdx + 4; }
    else { depth--; i = closeIdx + 5; }
  }
  return html.slice(start, i);
}

function stripTags(html) {
  let h = String(html || '');
  // drop script/style/nav/comment noise
  h = h
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(nav|aside|footer|form|iframe|svg|button|select|input)[\s>][\s\S]*?<\/\1>/gi, ' ')
    // math blocks (Wikipedia LaTeX) — unreadable aloud, drop entirely
    .replace(/<(math|semantics|annotation)[\s>][\s\S]*?<\/\1>/gi, ' ')
    .replace(/<span[^>]*class=["'][^"']*mwe-math[^"']*["'][^>]*>[\s\S]*?<\/span>/gi, ' ')
    // common boilerplate: infoboxes, navboxes, toc, metadata, jump links, coordinates
    .replace(/<(table|div|span|ul|ol|li|aside)[^>]*class=["'][^"']*(?:infobox|navbox|toc|mw-editsection|catlinks|noprint|printfooter|metadata|hatnote|dablink|portalbox|coordinates|mw-jump|mw-empty|ambox|sistersitebox|vertical-navbox|plainlinks)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<div[^>]*id=["'][^"']*(?:toc|mw-panel|footer|catlinks|coordinates)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, ' ');

  // prefer the main article body if present (Wikipedia: #mw-content-text)
  const main =
    grabBalanced(h, /<div[^>]*id=["']mw-content-text["'][^>]*>/i) ||
    h.match(/<article[\s\S]*?<\/article>/i) ||
    h.match(/<main[\s\S]*?<\/main>/i) ||
    grabBalanced(h, /<div[^>]*(?:class|itemprop)=["'][^"']*(?:articleBody|post-content|article-content|entry-content|story-body|article-body)[^"']*["'][^>]*>/i);
  if (main) h = typeof main === 'string' ? main : main[0];

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
  let html;
  if (buf.length > MAX_PAGE_BYTES) {
    // Oversized pages (Wikipedia, live blogs) used to hard-fail with
    // 'Page too large' — the Listen flow silently lost the full narration.
    // Keep the head of the page instead: it holds the lede + key facts, which
    // is exactly what the summary and narration need.
    html = buf.slice(0, MAX_PAGE_BYTES).toString('utf8');
    // Truncation may have cut mid-<script>/<style> — close them so their text
    // never leaks into the extraction, then jump past the <head> to content.
    html = html + '</script></style>';
    const headEnd = html.search(/<\/head\s*>/i); // case-insensitive — some publishers emit </HEAD>
    if (headEnd > 0) html = html.slice(headEnd + 7);
  } else {
    html = buf.toString('utf8');
  }
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

// ── TTS narrator (free: Microsoft Edge TTS — no key, no cost) ──
// Uses the same natural neural voices as Edge's Read Aloud, via
// edge-tts-universal. Keyless & free; audio cached server-side for 24h.
const TTS_CACHE_TTL = 24 * 60 * 60 * 1000; // 1 day — audio is expensive, cache long
const ttsCache = new Map(); // sha1(voice:rate:text) -> { audio: Buffer, ts }
const TTS_DEFAULT_VOICE = 'en-US-EmmaMultilingualNeural';

// Curated free Edge neural voices (id = Edge voice name)
const EDGE_VOICES = [
  { id: 'en-US-EmmaMultilingualNeural', name: 'Emma — US (multilingual)', lang: 'en-US' },
  { id: 'en-US-AriaNeural', name: 'Aria — US', lang: 'en-US' },
  { id: 'en-US-ChristopherNeural', name: 'Christopher — US', lang: 'en-US' },
  { id: 'en-US-GuyNeural', name: 'Guy — US', lang: 'en-US' },
  { id: 'en-US-JennyNeural', name: 'Jenny — US', lang: 'en-US' },
  { id: 'en-US-MichelleNeural', name: 'Michelle — US', lang: 'en-US' },
  { id: 'en-GB-SoniaNeural', name: 'Sonia — UK', lang: 'en-GB' },
  { id: 'en-GB-RyanNeural', name: 'Ryan — UK', lang: 'en-GB' },
  { id: 'en-IN-NeerjaNeural', name: 'Neerja — India', lang: 'en-IN' },
  { id: 'en-IN-PrabhatNeural', name: 'Prabhat — India', lang: 'en-IN' },
  { id: 'en-AU-NatashaNeural', name: 'Natasha — Australia', lang: 'en-AU' },
  { id: 'en-CA-ClaraNeural', name: 'Clara — Canada', lang: 'en-CA' },
  { id: 'de-DE-KatjaNeural', name: 'Katja — Germany', lang: 'de-DE' },
  { id: 'fr-FR-DeniseNeural', name: 'Denise — France', lang: 'fr-FR' },
  { id: 'es-ES-ElviraNeural', name: 'Elvira — Spain', lang: 'es-ES' },
  { id: 'hi-IN-SwaraNeural', name: 'Swara — Hindi', lang: 'hi-IN' },
];

// Deterministic cache key (exported for tests)
function ttsCacheKey(voice, text, variant) {
  return crypto.createHash('sha1').update(`${voice}:${variant || '1'}:${text}`).digest('hex');
}

// Map player speed (0.5–2) to an Edge rate string ('+0%', '+25%', '-10%', …)
function edgeRate(speed) {
  const s = Math.min(Math.max(Number(speed) || 1, 0.5), 2);
  const pct = Math.round((s - 1) * 100);
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}

// Map a pitch profile (0.5–1.5, default 1) to an Edge Hz offset ('+5Hz', …)
function edgePitch(pitch) {
  const p = Math.min(Math.max(Number(pitch) || 1, 0.5), 1.5);
  if (p === 1) return undefined;
  const hz = Math.round((p - 1) * 40);
  return `${hz >= 0 ? '+' : ''}${hz}Hz`;
}

// Free neural synthesis via Microsoft Edge TTS (no API key required).
// Pronunciation is handled client-side (Anchor.pronounce spelling-substitution
// dictionary) — the text arriving here is already phonetic ("en-VEE-dee-uh"),
// so no server-side lexicons or SSML are needed. NOTE: edge-tts-universal does
// NOT accept raw SSML input — it escapes the text and wraps it in its own SSML,
// so injecting <phoneme> tags would be spoken aloud literally. Avoid.
async function edgeTts(text, voice, speed, pitch) {
  const opts = { rate: edgeRate(speed) };
  const p = edgePitch(pitch);
  if (p) opts.pitch = p;
  const t = new EdgeTTS(String(text || '').slice(0, 5000), voice || TTS_DEFAULT_VOICE, opts);
  const result = await t.synthesize();
  const buf = Buffer.from(await result.audio.arrayBuffer());
  if (!buf.length) throw new Error('Edge TTS returned empty audio');
  return buf;
}

// ── Article summarizer (free: keyless Pollinations server-side + extractive fallback) ──
// Used by the Listen flow: scrape the full article, write an elegant spoken-word
// summary, then narrate THAT instead of raw scraped text.
const SUMMARY_CACHE_TTL = 60 * 60 * 1000; // 1h
const summaryCache = new Map();            // url -> { summary, engine, ts }

function cleanForSummary(text) {
  return String(text || '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Extractive fallback: lead sentence + following sentences, capped ~450 words
function extractiveSummary(text, maxWords = 450) {
  const clean = cleanForSummary(text);
  const sentences = clean.match(/[^.!?]+[.!?]+/g) || [clean];
  const lead = (sentences[0] || '').trim();
  if (!lead) return '';
  const out = [lead];
  let words = lead.split(/\s+/).length;
  for (let i = 1; i < sentences.length && words < maxWords; i++) {
    const s = sentences[i].trim();
    const n = s.split(/\s+/).length;
    if (words + n > maxWords) break;
    out.push(s);
    words += n;
  }
  return out.join(' ').slice(0, 3000);
}

// Prompt asking for a flowing spoken-word summary (no markdown, no bullets)
function buildSummaryPrompt(title, url, text) {
  const trimmed = String(text || '').slice(0, 12000);
  return `You are Aurora, a skilled news narrator. A user asked to hear about an article. Write a NATURAL-SPEAKING spoken summary of the article that flows beautifully when read aloud.

TITLE: ${title || 'Untitled'}
URL: ${url}

ARTICLE TEXT:
"""${trimmed}"""

WRITE (200-350 words, 4-7 short paragraphs):
- Open with a single compelling sentence: the headline fact or the core "what happened".
- Then the who/what/where/when/why, the key numbers, and the significance.
- End with a forward-looking closing line ("what to watch next").
- Plain conversational prose ONLY. NO markdown, NO bullets, NO "##" headers, NO brackets [1], NO URLs.
- Never invent facts not in the article; if the article is too short, say so briefly and summarize what's known.
- Write for the ear, not the eye.`;
}

async function pollinationsSummary(prompt) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch('https://text.pollinations.ai/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], model: 'openai' }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      const c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (typeof c === 'string' && c.trim()) return c.trim();
    } catch { /* plain text body */ }
    if (text && text.trim()) return text.trim();
    throw new Error('Empty AI response');
  } finally {
    clearTimeout(t);
  }
}

// Scrape + summarize one article (AI first, extractive fallback). Cached 1h.
async function summarizeArticle(url, title) {
  const cached = summaryCache.get(url);
  if (cached && Date.now() - cached.ts < SUMMARY_CACHE_TTL) return cached;

  const text = await fetchArticleText(url); // throws when unreadable
  let summary = '';
  let engine = 'extractive';
  try {
    const ai = await pollinationsSummary(buildSummaryPrompt(title, url, text));
    if (ai && ai.length > 120) { summary = ai; engine = 'ai'; }
  } catch { /* fall through to extractive */ }
  if (!summary) summary = extractiveSummary(text);
  if (!summary) throw new Error('No readable content');

  const out = { summary, engine };
  if (summaryCache.size > 300) {
    const k = summaryCache.keys().next().value;
    if (k) summaryCache.delete(k);
  }
  summaryCache.set(url, { ...out, ts: Date.now() });
  return out;
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
    }    // live news feed (keyless RSS aggregation, 5-min server cache)
    //   ?cat=top|world|tech|business|science|sports  → global professional feeds
    //   ?country=IN&cat=...                          → Google News for that country
    //   ?q=QUERY&country=IN                          → Google News topic search (country-scoped)
    if (event.httpMethod === 'GET' && url.pathname.endsWith('/news')) {
      const cat = (url.searchParams.get('cat') || 'top').toLowerCase();
      const country = (url.searchParams.get('country') || '').toUpperCase();
      const q = (url.searchParams.get('q') || '').trim();

      if (q || (country && NEWS_COUNTRIES[country])) {
        const items = await countryNewsSearch(country || 'US', q || null, cat);
        return { statusCode: 200, headers, body: JSON.stringify({
          ok: true, category: cat, country: country || 'US', query: q || null, results: items, engine: 'gnews'
        }) };
      }
      if (!NEWS_FEEDS[cat]) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'unknown category' }) };
      const items = await newsSearch(cat);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, category: cat, results: items, engine: 'rss' }) };
    }

    // free narrator voice list (Edge TTS — no key needed)
    if (event.httpMethod === 'GET' && url.pathname.endsWith('/tts/voices')) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, engine: 'edge-tts', voices: EDGE_VOICES }) };
    }

    // narrator status — always configured (free, no key required)
    if (event.httpMethod === 'GET' && url.pathname.endsWith('/tts/status')) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, configured: true, engine: 'edge-tts', default_voice: TTS_DEFAULT_VOICE }) };
    }

    // neural narration (free Edge TTS, cached audio bytes)
    if (event.httpMethod === 'POST' && url.pathname.endsWith('/tts')) {
      const body = JSON.parse(event.body || '{}');
      const text = String(body.text || '').trim();
      const voice = String(body.voice || '').trim();
      const speed = Math.min(Math.max(Number(body.speed) || 1, 0.5), 2); // honor player speed
      const pitch = Math.min(Math.max(Number(body.pitch) || 1, 0.5), 1.5); // voice-profile energy
      if (!text) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'missing text' }) };
      if (!voice) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'missing voice' }) };

      const hash = ttsCacheKey(voice, text, `${speed}:${pitch}`);
      // audio bytes are cached server-side for 24h, so a short browser cache is fine (and cheaper)
      const audioHeaders = { ...headers, 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=3600' };
      const hit = ttsCache.get(hash);
      if (hit && Date.now() - hit.ts < TTS_CACHE_TTL) {
        return { statusCode: 200, headers: audioHeaders, isBase64Encoded: true, body: hit.audio.toString('base64') };
      }
      const audio = await edgeTts(text, voice, speed, pitch);
      if (ttsCache.size > 200) {
        const oldest = ttsCache.keys().next().value;
        if (oldest) ttsCache.delete(oldest);
      }
      ttsCache.set(hash, { audio, ts: Date.now() });
      return { statusCode: 200, headers: audioHeaders, isBase64Encoded: true, body: audio.toString('base64') };
    }

    // article summary for narration (scrape -> elegant AI summary -> read aloud)
    if (event.httpMethod === 'POST' && url.pathname.endsWith('/summarize')) {
      const body = JSON.parse(event.body || '{}');
      const target = String(body.url || '').trim();
      const title = String(body.title || '').trim();
      if (!/^https?:\/\//.test(target)) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'missing url' }) };
      try {
        const out = await summarizeArticle(target, title);
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ...out, url: target }) };
      } catch (e) {
        return { statusCode: 422, headers, body: JSON.stringify({ ok: false, error: e.message }) };
      }
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

// ── keyless live news: category RSS feeds (professional outlets) ──
const NEWS_CACHE_TTL = 5 * 60 * 1000; // 5 min
const NEWS_MAX = 24;

const NEWS_FEEDS = {
  top: [
    'https://feeds.bbci.co.uk/news/rss.xml',
    'https://www.theguardian.com/world/rss',
    'https://techcrunch.com/feed/',
    'https://www.theverge.com/rss/index.xml',
  ],
  world: [
    'https://feeds.bbci.co.uk/news/world/rss.xml',
    'https://www.theguardian.com/world/rss',
  ],
  tech: [
    'https://feeds.bbci.co.uk/news/technology/rss.xml',
    'https://techcrunch.com/feed/',
    'https://www.theverge.com/rss/index.xml',
  ],
  business: [
    'https://feeds.bbci.co.uk/news/business/rss.xml',
    'https://www.theguardian.com/business/rss',
  ],
  science: [
    'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml',
  ],
  sports: [
    'https://feeds.bbci.co.uk/sport/rss.xml',
  ],
};

// Outlet label shown on each card (matched by index to the feeds above)
const NEWS_OUTLETS = {
  top: ['BBC News', 'The Guardian', 'TechCrunch', 'The Verge'],
  world: ['BBC World', 'The Guardian'],
  tech: ['BBC Tech', 'TechCrunch', 'The Verge'],
  business: ['BBC Business', 'The Guardian'],
  science: ['BBC Science'],
  sports: ['BBC Sport'],
};

const newsCache = new Map(); // key -> { items, ts }

// ── per-country news via Google News RSS (keyless, reliable, worldwide) ──
const NEWS_COUNTRIES = {
  US: { name: 'United States', flag: '🇺🇸', hl: 'en-US', gl: 'US', ceid: 'US:en' },
  GB: { name: 'United Kingdom', flag: '🇬🇧', hl: 'en-GB', gl: 'GB', ceid: 'GB:en' },
  IN: { name: 'India', flag: '🇮🇳', hl: 'en-IN', gl: 'IN', ceid: 'IN:en' },
  CA: { name: 'Canada', flag: '🇨🇦', hl: 'en-CA', gl: 'CA', ceid: 'CA:en' },
  AU: { name: 'Australia', flag: '🇦🇺', hl: 'en-AU', gl: 'AU', ceid: 'AU:en' },
  DE: { name: 'Germany', flag: '🇩🇪', hl: 'de-DE', gl: 'DE', ceid: 'DE:de' },
  FR: { name: 'France', flag: '🇫🇷', hl: 'fr-FR', gl: 'FR', ceid: 'FR:fr' },
  IT: { name: 'Italy', flag: '🇮🇹', hl: 'it-IT', gl: 'IT', ceid: 'IT:it' },
  ES: { name: 'Spain', flag: '🇪🇸', hl: 'es-ES', gl: 'ES', ceid: 'ES:es' },
  NL: { name: 'Netherlands', flag: '🇳🇱', hl: 'nl-NL', gl: 'NL', ceid: 'NL:nl' },
  JP: { name: 'Japan', flag: '🇯🇵', hl: 'ja-JP', gl: 'JP', ceid: 'JP:ja' },
  KR: { name: 'South Korea', flag: '🇰🇷', hl: 'ko-KR', gl: 'KR', ceid: 'KR:ko' },
  CN: { name: 'China', flag: '🇨🇳', hl: 'zh-CN', gl: 'CN', ceid: 'CN:zh-Hans' },
  BR: { name: 'Brazil', flag: '🇧🇷', hl: 'pt-BR', gl: 'BR', ceid: 'BR:pt' },
  MX: { name: 'Mexico', flag: '🇲🇽', hl: 'es-MX', gl: 'MX', ceid: 'MX:es' },
  AR: { name: 'Argentina', flag: '🇦🇷', hl: 'es-AR', gl: 'AR', ceid: 'AR:es' },
  ZA: { name: 'South Africa', flag: '🇿🇦', hl: 'en-ZA', gl: 'ZA', ceid: 'ZA:en' },
  NG: { name: 'Nigeria', flag: '🇳🇬', hl: 'en-NG', gl: 'NG', ceid: 'NG:en' },
  EG: { name: 'Egypt', flag: '🇪🇬', hl: 'ar-EG', gl: 'EG', ceid: 'EG:ar' },
  SA: { name: 'Saudi Arabia', flag: '🇸🇦', hl: 'ar-SA', gl: 'SA', ceid: 'SA:ar' },
  AE: { name: 'UAE', flag: '🇦🇪', hl: 'ar-AE', gl: 'AE', ceid: 'AE:ar' },
  IL: { name: 'Israel', flag: '🇮🇱', hl: 'en-IL', gl: 'IL', ceid: 'IL:en' },
  TR: { name: 'Turkey', flag: '🇹🇷', hl: 'tr-TR', gl: 'TR', ceid: 'TR:tr' },
  RU: { name: 'Russia', flag: '🇷🇺', hl: 'ru-RU', gl: 'RU', ceid: 'RU:ru' },
  SE: { name: 'Sweden', flag: '🇸🇪', hl: 'sv-SE', gl: 'SE', ceid: 'SE:sv' },
  PL: { name: 'Poland', flag: '🇵🇱', hl: 'pl-PL', gl: 'PL', ceid: 'PL:pl' },
  SG: { name: 'Singapore', flag: '🇸🇬', hl: 'en-SG', gl: 'SG', ceid: 'SG:en' },
  PH: { name: 'Philippines', flag: '🇵🇭', hl: 'en-PH', gl: 'PH', ceid: 'PH:en' },
  ID: { name: 'Indonesia', flag: '🇮🇩', hl: 'id-ID', gl: 'ID', ceid: 'ID:id' },
  TH: { name: 'Thailand', flag: '🇹🇭', hl: 'th-TH', gl: 'TH', ceid: 'TH:th' },
  PK: { name: 'Pakistan', flag: '🇵🇰', hl: 'en-PK', gl: 'PK', ceid: 'PK:en' },
  BD: { name: 'Bangladesh', flag: '🇧🇩', hl: 'bn-BD', gl: 'BD', ceid: 'BD:bn' },
  NZ: { name: 'New Zealand', flag: '🇳🇿', hl: 'en-NZ', gl: 'NZ', ceid: 'NZ:en' },
  IE: { name: 'Ireland', flag: '🇮🇪', hl: 'en-IE', gl: 'IE', ceid: 'IE:en' },
};

const NEWS_TOPICS = {
  world: 'WORLD', business: 'BUSINESS', technology: 'TECHNOLOGY',
  science: 'SCIENCE', sports: 'SPORTS', health: 'HEALTH',
};

function googleNewsUrl(country, q, cat) {
  const c = NEWS_COUNTRIES[country] || NEWS_COUNTRIES.US;
  const base = `hl=${c.hl}&gl=${c.gl}&ceid=${c.ceid}`;
  if (q) return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&${base}`;
  const topic = NEWS_TOPICS[cat];
  if (topic) return `https://news.google.com/rss/headlines/section/topic/${topic}?${base}`;
  return `https://news.google.com/rss?${base}`;
}

async function countryNewsSearch(country, q, cat) {
  const c = NEWS_COUNTRIES[country] || NEWS_COUNTRIES.US;
  const cacheKey = `${country}:${cat || 'top'}:${q || ''}`;
  const cached = newsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < NEWS_CACHE_TTL) return cached.items;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 9000);
  try {
    const res = await fetch(googleNewsUrl(country, q, cat), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AuroraResearch/1.0; news feed reader)', 'Accept': 'application/rss+xml, application/xml, text/xml, */*' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    if (!/<(item|entry)[ >]/i.test(xml)) throw new Error('Not an RSS feed');
    const items = parseRss(xml).map(it => ({
      ...it,
      meta: it.meta || 'Google News',
      location: c.name,
      flag: c.flag,
      country: c.code,
    }));
    newsCache.set(cacheKey, { items, ts: Date.now() });
    return items;
  } finally {
    clearTimeout(t);
  }
}

// Minimal RSS/Atom parser (regex-based, zero deps — handles BBC/Guardian/TechCrunch/Verge/Google News)
function parseRss(xml) {
  const items = [];
  const body = String(xml || '');
  // RSS 2.0 <item> or Atom <entry> blocks
  const blockRe = /<(item|entry)[^>]*>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = blockRe.exec(body)) && items.length < NEWS_MAX) {
    const blk = m[2];
    const grab = re => {
      const x = blk.match(re);
      return x ? x[1] : '';
    };
    const stripCdata = s => String(s || '').replace(/<!\[CDATA\[|\]\]>/g, '');
    const title = stripTags(decodeEntities(stripCdata(grab(/<title[^>]*>([\s\S]*?)<\/title>/i)))).trim();
    let link = grab(/<link>([\s\S]*?)<\/link>/i).trim();
    if (!link) link = decodeEntities(stripCdata(grab(/<link[^>]*href=["']([^"']+)["']/i))).trim(); // Atom style
    const desc = stripTags(decodeEntities(stripCdata(
      grab(/<description[^>]*>([\s\S]*?)<\/description>/i) || grab(/<summary[^>]*>([\s\S]*?)<\/summary>/i)
    ))).trim();
    const pubRaw = grab(/<pubDate>([\s\S]*?)<\/pubDate>/i).trim() || grab(/<updated>([\s\S]*?)<\/updated>/i).trim();
    const source = decodeEntities(stripCdata(grab(/<source[^>]*>([\s\S]*?)<\/source>/i))).trim();
    if (!title || !link) continue;
    items.push({
      title: title.slice(0, 200),
      url: link,
      snippet: desc.slice(0, 320),
      publishedAt: pubRaw ? new Date(pubRaw).getTime() : null,
      meta: source.slice(0, 60) || 'News',
    });
  }
  return items;
}

async function fetchFeed(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 9000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AuroraResearch/1.0; news feed reader)', 'Accept': 'application/rss+xml, application/xml, text/xml, */*' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    if (!/<(item|entry)[ >]/i.test(xml)) throw new Error('Not an RSS feed');
    return parseRss(xml);
  } finally {
    clearTimeout(t);
  }
}

async function newsSearch(cat) {
  const cached = newsCache.get(cat);
  if (cached && Date.now() - cached.ts < NEWS_CACHE_TTL) return cached.items;

  const feeds = NEWS_FEEDS[cat] || NEWS_FEEDS.top;
  const outlets = NEWS_OUTLETS[cat] || NEWS_OUTLETS.top;
  const settled = await Promise.allSettled(feeds.map((url, i) =>
    fetchFeed(url).then(items => items.map(it => ({ ...it, meta: outlets[i] || 'News' })))));

  const seen = new Set();
  const merged = [];
  for (const r of settled) {
    if (r.status !== 'fulfilled') continue;
    for (const it of r.value) {
      const key = it.title.toLowerCase().slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(it);
    }
  }
  // newest first, with unknown dates last
  merged.sort((a, b) => (b.publishedAt || -1) - (a.publishedAt || -1));
  const items = merged.slice(0, NEWS_MAX);
  newsCache.set(cat, { items, ts: Date.now() });
  return items;
}

// exported for unit tests
exports._stripTags = stripTags;
exports._grabBalanced = grabBalanced;
exports._decodeEntities = decodeEntities;
exports._parseDdgHtml = parseDdgHtml;
exports._parseRss = parseRss;
exports._NEWS_FEEDS = NEWS_FEEDS;
exports._NEWS_COUNTRIES = NEWS_COUNTRIES;
exports._googleNewsUrl = googleNewsUrl;
exports._ttsCacheKey = ttsCacheKey;
exports._edgeTts = edgeTts;
exports._edgeRate = edgeRate;
exports._EDGE_VOICES = EDGE_VOICES;
exports._extractiveSummary = extractiveSummary;
exports._buildSummaryPrompt = buildSummaryPrompt;
