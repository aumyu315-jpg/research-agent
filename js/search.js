/* ─────────────────────────────────────────────
   Aurora — multi-source search engine
   Sources (all CORS-verified, free):
     wikipedia · hackernews · web (Brave/DDG) · academic (OpenAlex+Crossref)
     news (GNews optional + Wikinews) · books (OpenLibrary) · qa (StackExchange)
     code (GitHub) · markets (CoinGecko) · weather (Open-Meteo)
   ───────────────────────────────────────────── */
const Search = (() => {
  const TIMEOUT = 18000;
  const NEWS_LIMIT = 20;

  async function fetchJSON(url, opts = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeout || TIMEOUT);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Wikipedia (search + summaries) ──
  async function wikipedia(q, limit) {
    const search = await fetchJSON(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=${limit}&format=json&origin=*&utf8=1`);
    const hits = (search.query && search.query.search) || [];
    const items = hits.map(h => ({
      id: 'wiki-' + h.pageid,
      source: 'wikipedia',
      title: h.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, '_'))}`,
      snippet: h.snippet ? h.snippet.replace(/<\/?span[^>]*>/g, '').replace(/<[^>]+>/g, '') : '',
      publishedAt: null,
    }));

    if (items.length) {
      try {
        const top = items[0];
        const ext = await fetchJSON(
          `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro&explaintext&titles=${encodeURIComponent(top.title)}&format=json&origin=*`);
        const page = ext.query && ext.query.pages && Object.values(ext.query.pages)[0];
        if (page && page.extract) top.snippet = page.extract.slice(0, 320);
      } catch { /* non-fatal */ }
    }
    return items;
  }

  // ── Hacker News (Algolia) ──
  async function hackerNews(q, limit) {
    const data = await fetchJSON(
      `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=${limit}`);
    return (data.hits || []).map(h => ({
      id: 'hn-' + h.objectID,
      source: 'hackernews',
      title: h.title || h.story_title || '(untitled)',
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      snippet: h.story_text ? h.story_text.replace(/<[^>]+>/g, '').slice(0, 300) : `${h.points || 0} points · ${h.num_comments || 0} comments on Hacker News`,
      publishedAt: h.created_at ? new Date(h.created_at).getTime() : null,
      meta: h.points || 0,
    }));
  }

  // ── Serverless web search (SearXNG/DDG via /api/search when backend is deployed) ──
  async function backendWebSearch(q) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data.ok || !Array.isArray(data.results) || !data.results.length) return null;
      return data.results;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── DuckDuckGo (web results, fallback when no backend) ──
  async function duckDuckGo(q, limit) {
    const data = await fetchJSON(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`);
    const items = [];
    if (data.AbstractText && data.AbstractURL) {
      items.push({
        id: 'ddg-abstract',
        source: 'web',
        title: data.Heading || 'Web result',
        url: data.AbstractURL,
        snippet: data.AbstractText.slice(0, 320),
        publishedAt: null,
      });
    }
    const walk = list => {
      for (const t of list || []) {
        if (t.Topics) walk(t.Topics);
        else if (t.FirstURL && t.Text) {
          items.push({
            id: 'ddg-' + t.FirstURL,
            source: 'web',
            title: t.Text.split(' - ')[0] || 'Web result',
            url: t.FirstURL,
            snippet: t.Text.slice(0, 300),
            publishedAt: null,
          });
        }
      }
    };
    walk(data.RelatedTopics || []);
    return items.slice(0, limit);
  }

  // ── Academic: OpenAlex + Crossref ──
  async function openAlex(q, limit) {
    const data = await fetchJSON(
      `https://api.openalex.org/works?search=${encodeURIComponent(q)}&per-page=${limit}&sort=relevance_score:desc&mailto=research@aurora.app`);
    return (data.results || []).map(w => ({
      id: 'oa-' + w.id,
      source: 'academic',
      title: w.title || 'Untitled paper',
      url: w.doi ? `https://doi.org/${w.doi}` : (w.primary_location && w.primary_location.landing_page_url) || `https://openalex.org/${w.id}`,
      snippet: (w.abstract_inverted_index ? Object.entries(w.abstract_inverted_index)
        .flatMap(([word, pos]) => pos.map(p => [p, word]))
        .sort((a, b) => a[0] - b[0]).map(p => p[1]).join(' ').slice(0, 300)
        : `Published ${w.publication_year || '?'} · ${w.cited_by_count || 0} citations`),
      publishedAt: w.publication_date ? new Date(w.publication_date).getTime() : null,
      meta: w.cited_by_count || 0,
    }));
  }

  async function crossref(q, limit) {
    const data = await fetchJSON(
      `https://api.crossref.org/works?query=${encodeURIComponent(q)}&rows=${limit}&select=title,URL,DOI,container-title,issued,is-referenced-by-count`);
    return (data.message && data.message.items || []).map(w => ({
      id: 'cr-' + (w.DOI || w.URL || Math.random().toString(36).slice(2)),
      source: 'academic',
      title: (w.title && w.title[0]) || 'Untitled paper',
      url: w.URL || (w.DOI ? `https://doi.org/${w.DOI}` : 'https://search.crossref.org'),
      snippet: `Published in ${(w['container-title'] && w['container-title'][0]) || 'a journal'} · ${w['is-referenced-by-count'] || 0} citations`,
      publishedAt: w.issued && w.issued['date-parts'] && w.issued['date-parts'][0] && w.issued['date-parts'][0][0]
        ? new Date(w.issued['date-parts'][0][0], (w.issued['date-parts'][0][1] || 1) - 1, w.issued['date-parts'][0][2] || 1).getTime() : null,
      meta: w['is-referenced-by-count'] || 0,
    }));
  }

  async function academic(q, limit) {
    const [oa, cr] = await Promise.all([
      openAlex(q, Math.ceil(limit * 0.7)).catch(() => []),
      crossref(q, Math.ceil(limit * 0.5)).catch(() => []),
    ]);
    // dedupe by title similarity, prefer OpenAlex
    const seen = new Set();
    const merged = [];
    for (const r of [...oa, ...cr]) {
      const key = r.title.toLowerCase().slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(r);
    }
    return merged.slice(0, limit);
  }

  // ── News: GNews (optional key) + Wikinews (keyless) ──
  async function gnews(q, limit, key) {
    if (!key) return [];
    const data = await fetchJSON(
      `https://gnews.io/api/v4/search?q=${encodeURIComponent(q)}&token=${encodeURIComponent(key)}&max=${limit}&lang=en`);
    return (data.articles || []).map(a => ({
      id: 'news-' + (a.url || Math.random().toString(36).slice(2)),
      source: 'news',
      title: a.title || 'News',
      url: a.url,
      snippet: a.description || '',
      publishedAt: a.publishedAt ? new Date(a.publishedAt).getTime() : null,
      meta: a.source && a.source.name,
    }));
  }

  async function wikinews(q, limit) {
    const data = await fetchJSON(
      `https://en.wikinews.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=${limit}&format=json&origin=*&utf8=1`);
    return (data.query && data.query.search || []).map(h => ({
      id: 'wikinews-' + h.pageid,
      source: 'news',
      title: h.title,
      url: `https://en.wikinews.org/wiki/${encodeURIComponent(h.title.replace(/ /g, '_'))}`,
      snippet: h.snippet ? h.snippet.replace(/<\/?span[^>]*>/g, '').replace(/<[^>]+>/g, '') : '',
      publishedAt: null,
      meta: 'Wikinews',
    }));
  }

  async function news(q, limit, key) {
    const [gn, wn] = await Promise.all([
      gnews(q, limit, key),
      wikinews(q, Math.ceil(limit / 2)).catch(() => []),
    ]);
    return [...gn, ...wn];
  }

  // ── Books (OpenLibrary) ──
  async function books(q, limit) {
    const data = await fetchJSON(
      `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=${limit}&fields=key,title,author_name,first_publish_year,edition_count`);
    return (data.docs || []).map(b => ({
      id: 'book-' + (b.key || b.title),
      source: 'books',
      title: b.title || 'Untitled book',
      url: `https://openlibrary.org${b.key || '/search'}`,
      snippet: `by ${(b.author_name || ['unknown']).slice(0, 3).join(', ')}${b.first_publish_year ? ` · first published ${b.first_publish_year}` : ''}`,
      publishedAt: b.first_publish_year ? new Date(b.first_publish_year, 0, 1).getTime() : null,
      meta: `${b.edition_count || 0} editions`,
    }));
  }

  // ── Q&A (StackExchange) ──
  async function qa(q, limit) {
    const data = await fetchJSON(
      `https://api.stackexchange.com/2.3/search/advanced?site=stackoverflow&q=${encodeURIComponent(q)}&pagesize=${limit}&order=desc&sort=relevance&filter=default`);
    return (data.items || []).map(it => ({
      id: 'qa-' + it.question_id,
      source: 'qa',
      title: it.title || 'Question',
      url: it.link,
      snippet: `Score ${it.score || 0} · ${it.answer_count || 0} answers${it.tags && it.tags.length ? ` · tags: ${it.tags.slice(0, 4).join(', ')}` : ''}`,
      publishedAt: it.creation_date ? it.creation_date * 1000 : null,
      meta: 'Stack Overflow',
    }));
  }

  // ── Code (GitHub repositories) ──
  async function code(q, limit) {
    const data = await fetchJSON(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=${limit}&sort=stars`, {
      headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'AuroraResearch' },
    });
    return (data.items || []).map(r => ({
      id: 'gh-' + r.id,
      source: 'code',
      title: r.full_name,
      url: r.html_url,
      snippet: r.description || '(no description)',
      publishedAt: r.pushed_at ? new Date(r.pushed_at).getTime() : null,
      meta: `${r.stargazers_count || 0}★ · ${r.language || '?'}`,
    }));
  }

  // ── Markets (CoinGecko + live prices) ──
  async function markets(q, limit) {
    const data = await fetchJSON(
      `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(q)}`);
    const coins = (data.coins || []).slice(0, limit);
    if (!coins.length) return [];

    // enrich top coins with live USD prices
    let prices = {};
    try {
      const ids = coins.slice(0, 6).map(c => c.id).join(',');
      const priceData = await fetchJSON(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);
      prices = priceData || {};
    } catch { /* prices optional */ }

    return coins.map(c => ({
      id: 'cg-' + c.id,
      source: 'markets',
      title: `${c.name} (${c.symbol.toUpperCase()})`,
      url: `https://www.coingecko.com/en/coins/${c.id}`,
      snippet: `Market cap rank #${c.market_cap_rank || '?'}` + (prices[c.id] && prices[c.id].usd != null ? ` · live price $${prices[c.id].usd.toLocaleString(undefined, { maximumFractionDigits: 6 })}` : ''),
      publishedAt: null,
      meta: c.market_cap_rank ? `rank #${c.market_cap_rank}` : 'CoinGecko',
    }));
  }

  // ── Weather (Open-Meteo: geocode then live forecast) ──
  async function weather(q) {
    const geo = await fetchJSON(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=en&format=json`);
    const place = geo.results && geo.results[0];
    if (!place) return [];
    const w = await fetchJSON(
      `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&timezone=auto`);
    const c = w.current || {};
    const weatherLabel = codeToLabel(c.weather_code);
    return [{
      id: 'wx-' + place.name,
      source: 'weather',
      title: `Live weather — ${place.name}${place.admin1 ? ', ' + place.admin1 : ''}${place.country_code ? ' (' + place.country_code + ')' : ''}`,
      url: `https://open-meteo.com/en/weather/${place.latitude},${place.longitude}`,
      snippet: `${weatherLabel} · ${c.temperature_2m != null ? c.temperature_2m + '°C' : '—'} (feels like ${c.apparent_temperature != null ? c.apparent_temperature + '°C' : '—'}) · humidity ${c.relative_humidity_2m != null ? c.relative_humidity_2m + '%' : '—'} · wind ${c.wind_speed_10m != null ? c.wind_speed_10m + ' km/h' : '—'}`,
      publishedAt: Date.now(),
      meta: 'Open-Meteo live',
    }];
  }

  function codeToLabel(code) {
    const map = {
      0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
      45: 'Fog', 48: 'Depositing rime fog', 51: 'Light drizzle', 53: 'Drizzle',
      55: 'Dense drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
      71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 80: 'Light showers',
      81: 'Showers', 82: 'Violent showers', 95: 'Thunderstorm', 96: 'Thunderstorm w/ hail', 99: 'Severe thunderstorm',
    };
    return map[code] || 'Weather conditions';
  }

  // ── LIVE NEWS FEED (serverless RSS preferred, keyless browser fallback) ──
  const LIVE_CATS = {
    top:      { label: 'Top stories', gnews: null,        wikinews: null,   hn: true },
    world:    { label: 'World',       gnews: 'world',     wikinews: 'World', hn: false },
    tech:     { label: 'Tech',        gnews: 'technology',wikinews: 'Science and technology', hn: true },
    business: { label: 'Business',    gnews: 'business',  wikinews: 'Business and economics', hn: false },
    science:  { label: 'Science',     gnews: 'science',   wikinews: 'Science and technology', hn: false },
    sports:   { label: 'Sports',      gnews: 'sports',    wikinews: 'Sports', hn: false },
  };

  // Hacker News front page — works from the browser with no key (fallback feed)
  async function hnFrontPage(limit) {
    const data = await fetchJSON(
      `https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=${limit}`);
    return (data.hits || []).map(h => ({
      id: 'hn-live-' + h.objectID,
      source: 'news',
      title: h.title || h.story_title || '(untitled)',
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      snippet: `${h.points || 0} points · ${h.num_comments || 0} comments on Hacker News`,
      publishedAt: h.created_at ? new Date(h.created_at).getTime() : null,
      meta: 'Hacker News',
    }));
  }

  // Wikinews category listing — keyless (fallback feed)
  async function wikinewsCat(cat, limit) {
    const data = await fetchJSON(
      `https://en.wikinews.org/w/api.php?action=query&list=categorymembers&cmtitle=Category:${encodeURIComponent(cat)}&cmlimit=${limit}&format=json&origin=*&utf8=1`);
    return ((data.query && data.query.categorymembers) || []).map(p => ({
      id: 'wn-live-' + p.pageid,
      source: 'news',
      title: p.title,
      url: `https://en.wikinews.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}`,
      snippet: 'Latest coverage from Wikinews',
      publishedAt: null,
      meta: 'Wikinews',
    }));
  }

  // GNews top headlines — only when a free key is configured
  async function gnewsTop(cat, limit, key) {
    if (!key) return [];
    const catParam = cat ? `&category=${encodeURIComponent(cat)}` : '';
    const data = await fetchJSON(
      `https://gnews.io/api/v4/top-headlines?token=${encodeURIComponent(key)}&lang=en&max=${limit}${catParam}`);
    return (data.articles || []).map(a => ({
      id: 'news-live-' + (a.url || Math.random().toString(36).slice(2)),
      source: 'news',
      title: a.title || 'News',
      url: a.url,
      snippet: a.description || '',
      publishedAt: a.publishedAt ? new Date(a.publishedAt).getTime() : null,
      meta: (a.source && a.source.name) || 'GNews',
    }));
  }

  // Serverless RSS aggregation (BBC/Guardian/TechCrunch/Verge) — primary live feed
  async function backendNews(cat) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetch(`/api/news?cat=${encodeURIComponent(cat)}`, { signal: ctrl.signal });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data.ok || !Array.isArray(data.results) || !data.results.length) return null;
      return data.results;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── COUNTRIES (Google News RSS locales) ──
  const COUNTRIES = [
    { code: 'US', name: 'United States', flag: '🇺🇸' },
    { code: 'GB', name: 'United Kingdom', flag: '🇬🇧' },
    { code: 'IN', name: 'India', flag: '🇮🇳' },
    { code: 'CA', name: 'Canada', flag: '🇨🇦' },
    { code: 'AU', name: 'Australia', flag: '🇦🇺' },
    { code: 'DE', name: 'Germany', flag: '🇩🇪' },
    { code: 'FR', name: 'France', flag: '🇫🇷' },
    { code: 'IT', name: 'Italy', flag: '🇮🇹' },
    { code: 'ES', name: 'Spain', flag: '🇪🇸' },
    { code: 'NL', name: 'Netherlands', flag: '🇳🇱' },
    { code: 'JP', name: 'Japan', flag: '🇯🇵' },
    { code: 'KR', name: 'South Korea', flag: '🇰🇷' },
    { code: 'CN', name: 'China', flag: '🇨🇳' },
    { code: 'BR', name: 'Brazil', flag: '🇧🇷' },
    { code: 'MX', name: 'Mexico', flag: '🇲🇽' },
    { code: 'AR', name: 'Argentina', flag: '🇦🇷' },
    { code: 'ZA', name: 'South Africa', flag: '🇿🇦' },
    { code: 'NG', name: 'Nigeria', flag: '🇳🇬' },
    { code: 'EG', name: 'Egypt', flag: '🇪🇬' },
    { code: 'SA', name: 'Saudi Arabia', flag: '🇸🇦' },
    { code: 'AE', name: 'UAE', flag: '🇦🇪' },
    { code: 'IL', name: 'Israel', flag: '🇮🇱' },
    { code: 'TR', name: 'Turkey', flag: '🇹🇷' },
    { code: 'RU', name: 'Russia', flag: '🇷🇺' },
    { code: 'SE', name: 'Sweden', flag: '🇸🇪' },
    { code: 'PL', name: 'Poland', flag: '🇵🇱' },
    { code: 'SG', name: 'Singapore', flag: '🇸🇬' },
    { code: 'PH', name: 'Philippines', flag: '🇵🇭' },
    { code: 'ID', name: 'Indonesia', flag: '🇮🇩' },
    { code: 'TH', name: 'Thailand', flag: '🇹🇭' },
    { code: 'PK', name: 'Pakistan', flag: '🇵🇰' },
    { code: 'BD', name: 'Bangladesh', flag: '🇧🇩' },
    { code: 'NZ', name: 'New Zealand', flag: '🇳🇿' },
    { code: 'IE', name: 'Ireland', flag: '🇮🇪' },
  ];

  function countryName(code) {
    const c = COUNTRIES.find(x => x.code === code);
    return c ? c.name : code;
  }

  // Serverless per-country feed + topic search (Google News RSS) with fallback
  async function backendCountryNews(cat, country, q) {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    else params.set('cat', cat || 'top');
    if (country) params.set('country', country);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetch(`/api/news?${params}`, { signal: ctrl.signal });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data.ok || !Array.isArray(data.results) || !data.results.length) return null;
      return data.results;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // Country-aware live news: serverless Google News -> global RSS -> HN front page
  async function liveNews(cat, settings, country) {
    const key = (cat && LIVE_CATS[cat]) ? cat : 'top';
    const meta = LIVE_CATS[key];

    if (country) {
      const cnews = await backendCountryNews(key, country);
      if (cnews && cnews.length) return { results: cnews, engine: 'gnews', sources: ['news'], country };
    }

    const backend = await backendNews(key);
    if (backend && backend.length) return { results: backend, engine: 'rss', sources: ['rss'] };

    const per = Math.min(Math.max(Number((settings || {}).perSource) || 8, 3), 15);
    const jobs = [];
    if (meta.hn) jobs.push(hnFrontPage(per).catch(() => []));
    if (meta.wikinews) jobs.push(wikinewsCat(meta.wikinews, Math.ceil(per / 2)).catch(() => []));
    if (meta.gnews) jobs.push(gnewsTop(meta.gnews, per, (settings || {}).newsKey).catch(() => []));

    const groups = await Promise.all(jobs);
    const seen = new Set();
    const merged = [];
    for (const items of groups) {
      for (const it of items) {
        const dupKey = (it.title || '').toLowerCase().slice(0, 70);
        if (seen.has(dupKey)) continue;
        seen.add(dupKey);
        merged.push(it);
      }
    }
    merged.sort((a, b) => (b.publishedAt || -1) - (a.publishedAt || -1));
    return { results: merged.slice(0, NEWS_LIMIT), engine: 'fallback', sources: ['hackernews', 'news'] };
  }

  // Topic news search: serverless Google News (country-scoped) -> HN search fallback
  async function searchNews(q, settings, country) {
    const snews = await backendCountryNews(null, country, q);
    if (snews && snews.length) return { results: snews, engine: 'gnews', sources: ['news'], country };
    // fallback: HN search + global live feed
    const per = Math.min(Math.max(Number((settings || {}).perSource) || 8, 3), 15);
    const [hn, live] = await Promise.all([
      hackerNews(q, per).catch(() => []),
      liveNews('top', settings).catch(() => ({ results: [] })),
    ]);
    const seen = new Set();
    const merged = [];
    for (const it of [...hn.map(h => ({ ...h, source: 'news', meta: 'Hacker News' })), ...(live.results || [])]) {
      const dupKey = (it.title || '').toLowerCase().slice(0, 70);
      if (seen.has(dupKey)) continue;
      seen.add(dupKey);
      merged.push(it);
    }
    merged.sort((a, b) => (b.publishedAt || -1) - (a.publishedAt || -1));
    return { results: merged.slice(0, NEWS_LIMIT), engine: 'fallback', sources: ['news'] };
  }

  // ── LIVE TICKER ──
  // Markets: CoinGecko top coins with 24h change (keyless, CORS-verified)
  async function liveMarkets(limit = 6) {
    const data = await fetchJSON(
      `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${limit}&page=1&sparkline=false&price_change_percentage=24h`);
    return (data || []).map(c => ({
      symbol: (c.symbol || '').toUpperCase(),
      name: c.name,
      price: c.current_price,
      change24h: c.price_change_percentage_24h,
      url: `https://www.coingecko.com/en/coins/${c.id}`,
    }));
  }

  // Weather: a few major cities via Open-Meteo (keyless, CORS-verified)
  const TICKER_CITIES = [
    { name: 'London', lat: 51.5085, lon: -0.1257 },
    { name: 'New York', lat: 40.7143, lon: -74.006 },
    { name: 'Tokyo', lat: 35.6895, lon: 139.6917 },
    { name: 'Sydney', lat: -33.8679, lon: 151.2073 },
    { name: 'Mumbai', lat: 19.0728, lon: 72.8826 },
  ];
  async function liveWeather() {
    const jobs = TICKER_CITIES.map(async c => {
      const w = await fetchJSON(
        `https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}&current=temperature_2m,weather_code&timezone=auto`);
      const cur = w.current || {};
      return {
        city: c.name,
        temp: cur.temperature_2m,
        label: codeToLabel(cur.weather_code),
        url: `https://open-meteo.com/en/weather/${c.lat},${c.lon}`,
      };
    });
    const settled = await Promise.allSettled(jobs);
    return settled.filter(r => r.status === 'fulfilled').map(r => r.value);
  }

  // ── Query-type detection (heuristic scoring) ──
  const TYPE_HINTS = {
    weather: [/weather|forecast|temperature|rain|snow|humidity|storm|wind|°c|°f|conditions in|celsius|fahrenheit/i],
    markets: [/price|stock|share price|bitcoin|ethereum|crypto|forex|exchange rate|market cap|ticker|index|nasdaq|nyse|fund|etf|usd|eur|gbp|inr|gold price|oil price|recession|inflation|gdp|interest rate/i],
    news: [/breaking|latest news|headlines|today's|this week|announced|election|war|conflict|disaster|outbreak|scandal|resign|launch(es|ed)? today|developments/i],
    academic: [/paper|research|study|journal|academic|thesis|literature|meta-?analysis|peer-?review|scientific|doi|preprint|citation/i],
    code: [/github|repository|repo|npm|package|library|framework|api |sdk|bug|error|debug|docker|kubernetes|react|vue|python|javascript|typescript|rust|go |database|programming|code|software|deploy/i],
    books: [/book|novel|author|biography|literature|isbn|edition|publisher|read |chapter|memoir/i],
    qa: [/how do i|how to|why does|what is the best|difference between|step-?by-?step|troubleshoot|fix |does not work|error message|stack ?overflow/i],
  };

  const TYPE_META = {
    weather:   { label: 'Weather',   primary: ['weather'],   keep: ['web', 'wikipedia'] },
    markets:   { label: 'Markets',   primary: ['markets'],   keep: ['news', 'web'] },
    news:      { label: 'News',      primary: ['news'],      keep: ['hackernews', 'web'] },
    academic:  { label: 'Academic',  primary: ['academic'],  keep: ['wikipedia', 'web'] },
    code:      { label: 'Code',      primary: ['code'],      keep: ['qa', 'hackernews', 'web'] },
    books:     { label: 'Books',     primary: ['books'],     keep: ['wikipedia', 'web'] },
    qa:        { label: 'Q&A',       primary: ['qa'],        keep: ['code', 'web', 'wikipedia'] },
  };

  function detectType(query) {
    const q = String(query || '');
    if (q.length < 3) return null;
    const scores = {};
    for (const [type, patterns] of Object.entries(TYPE_HINTS)) {
      let score = 0;
      for (const re of patterns) {
        const m = q.match(re);
        if (m) score += Math.max(1, m[0].length / 4);
      }
      if (score > 0) scores[type] = score;
    }
    const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    return sorted.length ? sorted[0][0] : null;
  }

  // Decide which sources run & at what weight, given a detected type
  function routeSources(type, enabled) {
    const all = Object.keys(enabled).filter(k => enabled[k]);
    if (!type || !TYPE_META[type]) return { sources: all, boost: {} };

    const meta = TYPE_META[type];
    const primary = meta.primary.filter(s => enabled[s]);
    const keep = meta.keep.filter(s => enabled[s] && !primary.includes(s));
    // General-purpose sources always available when enabled
    const general = ['wikipedia', 'web', 'hackernews'].filter(s => enabled[s] && !primary.includes(s) && !keep.includes(s));
    // Everything else is deprioritized (skipped) when a type is strongly detected
    const others = all.filter(s => !primary.includes(s) && !keep.includes(s) && !general.includes(s));

    const sources = [...primary, ...keep, ...general];
    const boost = {};
    primary.forEach(s => boost[s] = 2);   // double results from the matching source
    keep.forEach(s => boost[s] = 1.2);
    general.forEach(s => boost[s] = 1);
    others.forEach(s => boost[s] = 0);    // skip irrelevant sources (saves rate limits)

    return { sources, boost };
  }

  // ── Orchestrator ──
  async function run(query, settings) {
    const perSource = Math.min(Math.max(Number(settings.perSource) || 8, 3), 15);
    const enabled = settings.sources || {
      wikipedia: true, hackernews: true, web: true, academic: true, news: false,
      books: true, qa: true, code: true, markets: true, weather: true,
    };
    const autoRoute = settings.autoRoute !== false;
    const detected = autoRoute ? detectType(query) : null;
    const { sources, boost } = routeSources(detected, enabled);

    const sized = s => Math.min(Math.max(Math.round(perSource * (boost[s] || 1)), 2), 15);
    const jobs = sources.map(s => {
      const n = sized(s);
      return [s, {
        wikipedia: () => wikipedia(query, n),
        hackernews: () => hackerNews(query, n),
        web: async () => { const b = await backendWebSearch(query); return b || duckDuckGo(query, n); },
        academic: () => academic(query, n),
        news: () => news(query, n, settings.newsKey),
        books: () => books(query, n),
        qa: () => qa(query, n),
        code: () => code(query, n),
        markets: () => markets(query, n),
        weather: () => weather(query),
      }[s]];
    });

    const results = [];
    const errors = [];

    await Promise.all(jobs.map(async ([name, fn]) => {
      try {
        const items = await fn();
        results.push(...items);
      } catch (e) {
        errors.push({ source: name, message: e.message });
      }
    }));

    return { query, results, errors, sources: jobs.map(([n]) => n), detected };
  }

  return { run, detectType, routeSources, TYPE_META, liveNews, liveMarkets, liveWeather, LIVE_CATS, COUNTRIES, countryName, searchNews, sourceMeta: {
    wikipedia:   { label: 'Wikipedia',   color: 'src-wikipedia',   icon: 'i-book' },
    hackernews:  { label: 'Hacker News', color: 'src-hackernews',  icon: 'i-hn' },
    web:         { label: 'Web',         color: 'src-web',         icon: 'i-globe' },
    academic:    { label: 'Academic',    color: 'src-academic',    icon: 'i-academic' },
    news:        { label: 'News',        color: 'src-news',        icon: 'i-news' },
    books:       { label: 'Books',       color: 'src-books',       icon: 'i-book' },
    qa:          { label: 'Q&A',         color: 'src-qa',          icon: 'i-qa' },
    code:        { label: 'Code',        color: 'src-code',        icon: 'i-code' },
    markets:     { label: 'Markets',     color: 'src-market',      icon: 'i-market' },
    weather:     { label: 'Weather',     color: 'src-weather',     icon: 'i-weather' },
  }};
})();
