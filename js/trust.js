/* ─────────────────────────────────────────────
   Aurora — source trust engine
   Classifies any search-result URL into a trust tier and a
   credibility score, so the UI (and reports) can show
   🟢 High / 🟡 Medium / 🔴 Low confidence per source.

   Tiers:
     T1  Government, academic institutions, UN/WHO/NIH/OECD,
         official filings, primary data providers
     T2  Established news agencies & major outlets (Reuters, AP, BBC…)
     T3  Niche outlets, aggregators, developer platforms, wikis, blogs
     T4  Forums & user-generated content (Reddit, HN, Quora…)
   ───────────────────────────────────────────── */
const Trust = (() => {
  // Known-domain overrides (matched against the hostname suffix)
  const DOMAIN_TIERS = {
    // T1 — government / academia / authoritative bodies
    'who.int': 1, 'nih.gov': 1, 'cdc.gov': 1, 'oecd.org': 1, 'un.org': 1,
    'unesco.org': 1, 'imf.org': 1, 'worldbank.org': 1, 'ec.europa.eu': 1,
    'europa.eu': 1, 'gov.uk': 1, 'sec.gov': 1, 'fda.gov': 1, 'noaa.gov': 1,
    'nasa.gov': 1, 'arxiv.org': 1, 'nature.com': 1, 'science.org': 1,
    'sciencedirect.com': 1, 'springer.com': 1, 'ieee.org': 1,
    'openalex.org': 1, 'crossref.org': 1, 'doi.org': 1,
    // T2 — established news agencies & major outlets
    'reuters.com': 2, 'apnews.com': 2, 'bbc.com': 2, 'bbc.co.uk': 2,
    'ft.com': 2, 'bloomberg.com': 2, 'wsj.com': 2, 'nytimes.com': 2,
    'washingtonpost.com': 2, 'economist.com': 2, 'theguardian.com': 2,
    'cnbc.com': 2, 'npr.org': 2, 'abcnews.go.com': 2, 'cbsnews.com': 2,
    'cnn.com': 2, 'theatlantic.com': 2, 'newyorker.com': 2, 'time.com': 2,
    'forbes.com': 2, 'coingecko.com': 2, 'open-meteo.com': 2, 'openlibrary.org': 2,
    // T3 — niche outlets, aggregators, wikis, developer platforms
    'wikipedia.org': 3, 'medium.com': 3, 'substack.com': 3, 'techcrunch.com': 3,
    'theverge.com': 3, 'arstechnica.com': 3, 'wired.com': 3, 'github.com': 3,
    'stackexchange.com': 3, 'goodreads.com': 3, 'producthunt.com': 3,
    // T4 — forums & user-generated content
    'reddit.com': 4, 'news.ycombinator.com': 4, 'hn.algolia.com': 4,
    'quora.com': 4, 'stackoverflow.com': 4, 'youtube.com': 4, 'twitter.com': 4,
    'x.com': 4,
  };

  const TIER_INFO = {
    1: { label: 'Tier 1 · Authority', emoji: '🟢', color: 'green', hint: 'Government, academic or primary source' },
    2: { label: 'Tier 2 · Established', emoji: '🟢', color: 'green', hint: 'Major news agency or outlet' },
    3: { label: 'Tier 3 · General', emoji: '🟡', color: 'yellow', hint: 'Niche outlet, aggregator or wiki' },
    4: { label: 'Tier 4 · User content', emoji: '🔴', color: 'red', hint: 'Forum or user-generated content' },
  };

  const BASE_CREDIBILITY = { 1: 92, 2: 84, 3: 68, 4: 48 };

  function hostOf(url) {
    try {
      return String(url || '').replace(/^[a-z]+:\/\//i, '').split('/')[0].split(':')[0].toLowerCase();
    } catch { return ''; }
  }

  // Longest-suffix match against known domains, then TLD rules.
  function tierFor(url) {
    const host = hostOf(url);
    if (!host) return 3;
    const parts = host.split('.');
    // exact / suffix match (e.g. "www.bbc.co.uk" -> "bbc.co.uk")
    for (let i = 0; i < parts.length - 1; i++) {
      const suffix = parts.slice(i).join('.');
      if (DOMAIN_TIERS[suffix] != null) return DOMAIN_TIERS[suffix];
    }
    // TLD heuristics for everything else
    const tld = parts[parts.length - 1];
    if (tld === 'gov' || tld === 'mil' || tld === 'int') return 1;
    if (tld === 'edu' || tld === 'ac') return 1; // academic institutions
    return 3; // default: general web
  }

  function tierInfo(tier) {
    return TIER_INFO[tier] || TIER_INFO[3];
  }

  // Credibility score 0–100 for a search result object { url, title, snippet, publishedAt }.
  function score(r) {
    const tier = tierFor((r || {}).url);
    let cred = BASE_CREDIBILITY[tier] || 68;
    if (r.publishedAt) cred += 4;                        // dated sources are more trustworthy
    if ((r.snippet || '').length >= 60) cred += 2;       // substantive snippets
    if (!(r.url || '')) cred -= 10;
    cred = Math.max(38, Math.min(98, cred));
    return {
      tier,
      credibility: Math.round(cred),
      label: TIER_INFO[tier].label,
      emoji: TIER_INFO[tier].emoji,
      color: colorOf(cred),
      hint: TIER_INFO[tier].hint,
    };
  }

  function colorOf(credibility) {
    if (credibility >= 80) return 'green';
    if (credibility >= 60) return 'yellow';
    return 'red';
  }

  return { tierFor, tierInfo, score, colorOf, TIER_INFO };
})();
