/* ─────────────────────────────────────────────
   Aurora — Anchor narration engine
   Turns an article (or report) into a professional
   news-anchor broadcast script — never raw TTS.

   Pipeline: Content Intelligence → Narrative
   Construction → Anchor Script → Pronunciation →
   chapter-ordered text for the neural synthesizer.

   Pure + offline: every function here is heuristic
   and deterministic, so the briefing always works
   (AI summaries are a bonus layer on top).
   ───────────────────────────────────────────── */
const Anchor = (() => {

  // ────────────────────────── STORY TYPE DETECTION ──────────────────────────
  const STORY_TYPES = {
    breaking: {
      label: 'Breaking',
      keywords: ['breaking', 'developing', 'just in', 'urgent', 'live update', 'flash', 'emergency', 'as it happens', 'confirmed'],
      openings: ['We begin with breaking developments', 'We start with news just coming in', 'First, a developing story'],
      closings: ['We\'ll continue to follow this story as more details emerge', 'Stay with us for updates as this develops', 'More details are expected shortly'],
    },
    politics: {
      label: 'Politics',
      keywords: ['president', 'election', 'senate', 'congress', 'parliament', 'minister', 'government', 'policy', 'vote', 'campaign', 'diplomatic', 'lawmaker', 'prime minister', 'cabinet', 'ballot', 'bilateral'],
      openings: ['In politics today', 'Turning to the political scene', 'In Washington today'],
      closings: ['The political impact of this decision will be closely watched', 'Observers say this could shape the political debate for months', 'The political fallout continues to be assessed'],
    },
    finance: {
      label: 'Finance',
      keywords: ['market', 'stock', 'shares', 'economy', 'inflation', 'interest rate', 'federal reserve', 'bank', 'profit', 'revenue', 'earnings', 'oil price', 'gdp', 'billion', 'trillion', 'currency', 'bonds', 'index', 'investor', 'dow', 'nasdaq', 's&p', 'rally', 'downturn', 'recession'],
      openings: ['Turning to the markets', 'On the economic front', 'In financial news'],
      closings: ['Markets will be watching these numbers closely in the days ahead', 'Investors are weighing what this means for the broader economy', 'Analysts say the full impact will take time to measure'],
    },
    technology: {
      label: 'Technology',
      keywords: ['ai', 'artificial intelligence', 'chip', 'semiconductor', 'software', 'app', 'startup', 'internet', 'cyber', 'data breach', 'robot', 'electric vehicle', 'quantum', 'satellite', 'smartphone', 'openai', 'anthropic', 'nvidia', 'google', 'microsoft', 'apple', 'samsung', 'huawei', 'tesla', 'algorithm', 'cloud'],
      openings: ['Now to technology', 'In the world of tech', 'Turning to the technology sector'],
      closings: ['Tech watchers say this marks a significant shift for the industry', 'The technology sector is watching this development closely', 'Industry experts say this could accelerate the next wave of innovation'],
    },
    science: {
      label: 'Science',
      keywords: ['study', 'research', 'scientists', 'nasa', 'climate', 'space', 'gene', 'dna', 'vaccine', 'physicists', 'planet', 'climate change', 'university', 'researchers', 'telescope', 'experiment', 'breakthrough', 'particle', 'genome', 'orbit'],
      openings: ['And now to science', 'In science news', 'Researchers have a new finding'],
      closings: ['Scientists say more research is needed to confirm the findings', 'The study opens new questions for researchers', 'This adds to a growing body of scientific evidence'],
    },
    human_interest: {
      label: 'Human interest',
      keywords: ['community', 'family', 'rescue', 'donation', 'volunteer', 'celebrat', 'survivor', 'school', 'teacher', 'festival', 'neighbor', 'fundraiser', 'hero', 'story of', 'reunited', 'charity'],
      openings: ['And now, a story that matters to many', 'In a heartening story', 'A story worth sharing'],
      closings: ['A reminder of the difference people can make', 'The community says the gesture means more than words can say', 'It\'s a story that has resonated far beyond the community'],
    },
    sports: {
      label: 'Sports',
      keywords: ['match', 'tournament', 'league', 'championship', 'goal', 'final', 'team', 'player', 'coach', 'olympic', 'world cup', 'pitch', 'stadium', 'record', 'medal', 'qualif', 'manager', 'captain', 'season'],
      openings: ['On the field today', 'In sports', 'Turning to the sporting world'],
      closings: ['The season continues to throw up surprises', 'Fans will be watching the next fixture closely', 'The countdown to the next big match is on'],
    },
    investigation: {
      label: 'Investigation',
      keywords: ['investigation', 'probe', 'allegation', 'lawsuit', 'corruption', 'fraud', 'leaked', 'whistleblower', 'scandal', 'indictment', 'prosecutor', 'testimony', 'hearing', 'charges', 'evidence', 'inquiry', 'subpoena'],
      openings: ['Now to an unfolding investigation', 'In a significant legal development', 'Turning to the investigation'],
      closings: ['The investigation remains ongoing', 'Legal experts say the case could take months to resolve', 'Further developments are expected as the inquiry continues'],
    },
  };

  function detectStoryType(title, text) {
    const hay = `${title || ''} ${text || ''}`.toLowerCase();
    let best = null;
    for (const [type, meta] of Object.entries(STORY_TYPES)) {
      const score = meta.keywords.reduce((n, k) => n + (hay.includes(k) ? 1 : 0), 0);
      if (score > 0 && (!best || score > best.score)) best = { type, score, meta };
    }
    return best ? best : { type: 'general', score: 0, meta: { label: 'General', openings: ['Here is what you need to know'], closings: ['That\'s the story for now — listen again any time for the latest'] } };
  }

  // ────────────────────────── CONTENT INTELLIGENCE ──────────────────────────
  // Lines that must never be read aloud — adverts, widgets, boilerplate labels.
  // Ambiguous words (image/photo/video/watch/listen) require a colon so real
  // sentences like "Image recognition is improving…" are never dropped.
  const JUNK_LINE = /^(?:image\s*\d*\s*:|photo\s*:|video\s*:|gallery\s*:|watch\s*:|listen\s*:|advertisement:?|advertorial:?|sponsored(?: content)?:?|click here|read more|related (?:stories|articles|reads?):?|sign up|newsletter:?|subscribe(?: now)?:?|follow us|share this|tweet(?:ed)? by|posted by|also read|trending (?:now|today)|popular now|in this article|table of contents|more from|recommended for you|editor\\'s pick|top stories)(?:\b|[:\s])/i;
  const JUNK_PHRASE = /\b(advertisement|sponsored content|newsletter box|related articles?|related stories|click here|sign up|subscribe now|follow us on|share this story)\b/gi;
  // URLs, social handles, pure navigation text
  const JUNK_TOKEN = /\b(?:https?:\/\/\S+|www\.\S+|@\w{2,}|#\w{2,})\b/g;

  function stripBoilerplate(text) {
    const src = String(text || '');
    return src
      .split(/\n+/)
      .map(line => line.trim())
      .filter(line => line && !JUNK_LINE.test(line))
      .join('\n')
      .replace(JUNK_PHRASE, ' ')
      .replace(JUNK_TOKEN, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n\n')
      .trim();
  }

  function sentences(text) {
    const clean = stripBoilerplate(text)
      .replace(/(^|[\n.])[#>*\-•·]\s+/gm, '$1 ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!clean) return [];
    return (clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [])
      .map(s => s.replace(/\s+/g, ' ').trim())
      .filter(s => s.length > 1);
  }

  // Remove low-value markdown/HTML that would otherwise be read aloud.
  function cleanProse(text) {
    return String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(^|\s)(#{1,6})\s+/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/==([^=]+)==/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/(^|\s)[-*+]\s+/g, '$1 ')
      .replace(/^(\s*>\s?)+/gm, '')
      .replace(/\|/g, ', ')
      .replace(/\[(\d+)\]/g, ' ')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ────────────────────────── PRONUNCIATION ENGINE ──────────────────────────
  // Curated spoken-form dictionary. Written for the ear: reliable across the
  // neural narrator AND browser Web Speech voices.
  const PRONUNCIATIONS = [
    [/\bNVIDIA\b/gi, 'en-VEE-dee-uh'],
    [/\bTSMC\b/gi, 'T S M C'],
    [/\bOpenAI\b/gi, 'Open A I'],
    [/\bAnthropic\b/gi, 'AN-thruh-pik'],
    [/\bMistral\b/gi, 'MISS-truhl'],
    [/\bPalantir\b/gi, 'puh-LAN-ter'],
    [/\bBhubaneswar\b/gi, 'BOO-bah-nays-wahr'],
    [/\bGitHub\b/gi, 'Git-Hub'],
    [/\bYouTube\b/gi, 'You-Tube'],
    [/\bWhatsApp\b/gi, 'Whats-App'],
    [/\bSpaceX\b/gi, 'Space-X'],
    [/\bmRNA\b/gi, 'M R N A'],
    [/\bUNESCO\b/gi, 'you-NESS-coe'],
    [/\bNASA\b/gi, 'NAH-suh'],
    [/\bAI\b/gi, 'A I'],
    [/\bEU\b/gi, 'E U'],
    [/\bUK\b/gi, 'U K'],
    [/\bUS\b/gi, 'U S'],
    [/\bUN\b/gi, 'U N'],
    [/\bGDP\b/gi, 'G D P'],
    [/\bETF\b/gi, 'E T F'],
    [/\bIPO\b/gi, 'I P O'],
    [/\bCEO\b/gi, 'C E O'],
    [/\bCFO\b/gi, 'C F O'],
    [/\bCTO\b/gi, 'C T O'],
    [/\bQ([1-4])\b/gi, (_m, q) => ['first', 'second', 'third', 'fourth'][Number(q) - 1] + ' quarter'],
    [/\be\.g\./gi, 'for example'],
    [/\bi\.e\./gi, 'that is'],
    [/\betc\./gi, 'and so on'],
    [/\bvs\./gi, 'versus'],
    [/\b&\b/g, ' and '],
    [/\$(\d[\d,.]*)(?:\s*(billion|million|trillion|thousand)s?)?\b/gi, (_m, n, unit) => unit ? `${n} ${unit} dollars` : `${n} dollars`],
    [/\$/g, ' dollars'],
    [/\€(\d[\d,.]*)(?:\s*(billion|million|trillion|thousand)s?)?\b/gi, (_m, n, unit) => unit ? `${n} ${unit} euros` : `${n} euros`],
    [/£(\d[\d,.]*)(?:\s*(billion|million|trillion|thousand)s?)?\b/gi, (_m, n, unit) => unit ? `${n} ${unit} pounds` : `${n} pounds`],
    [/(\d[\d,.]*)\s*%/g, '$1 percent'],
    [/(\d[\d,.]*)\s*°C/g, '$1 degrees Celsius'],
    [/(\d[\d,.]*)\s*°F/g, '$1 degrees Fahrenheit'],
    [/\bkm\/h\b/gi, 'kilometers per hour'],
    [/\bmpg\b/gi, 'miles per gallon'],
    [/\bFAQ\b/gi, 'F A Q'],
    [/\b5G\b/gi, 'five G'],
  ];

  function pronounce(text, cache) {
    let out = String(text || '');
    for (const [re, repl] of PRONUNCIATIONS) {
      out = out.replace(re, repl);
    }
    return out.replace(/\s{2,}/g, ' ').trim();
  }

  // ────────────────────────── NARRATIVE CONSTRUCTION ──────────────────────────
  const TRANSITIONS = [
    'Turning now to the details',
    'In related developments',
    'To better understand the significance',
    'Looking at the broader picture',
    'Meanwhile',
    'To put this into context',
    'Adding to that',
    'And here is what that means in practice',
    'Looking ahead',
  ];

  const FACTS_HINT = /[$€£¥%]|\d[\d,.]*\s*(?:percent|million|billion|trillion|k|m|b)|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d/i;
  const VOICE_HINT = /["“”']|according to|\bsaid\b|\btold\b|\bwarns?\b|\bargues?\b|\bsuggests?\b|\breports?\b/i;

  function cleanHeadline(title) {
    return String(title || '')
      .replace(/^(\[|\(|(breaking|live|urgent|exclusive|update|just in)s?:?\s*)+/i, '')
      .replace(/[\[\]()"“”]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function wordCount(text) {
    return String(text || '').trim().split(/\s+/).filter(Boolean).length;
  }

  function estimateSeconds(words) {
    return Math.max(15, Math.round((words || 0) / 2.6)); // ~155 wpm broadcast pace
  }

  // Rotating transition picker — never repeats until the pool is exhausted.
  function makeTransitionPicker() {
    const pool = [...TRANSITIONS];
    let last = '';
    return () => {
      if (pool.length < 2) pool.push(last);
      let t = pool[Math.floor(Math.random() * pool.length)];
      if (t === last) t = pool.find(x => x !== last) || t;
      last = t;
      pool.splice(pool.indexOf(t), 1);
      return t;
    };
  }

  const pick = arr => arr[Math.floor(Math.random() * arr.length)];

  /**
   * Build a broadcast script from any article-ish text.
   * @returns {{ storyType:string, script:string, chapters:Array<{title:string,text:string}>, words:number, seconds:number, mode:string }}
   */
  function buildScript({ title, source, text, mode }) {
    const isDeep = mode === 'deep';
    const type = detectStoryType(title, text);
    const head = cleanHeadline(title);
    const sents = dedupe(sentences(text || ''));
    const nextTransition = makeTransitionPicker();

    // classify each sentence exactly once, in story order
    const buckets = { lead: [], facts: [], voices: [], rest: [] };
    sents.forEach((s, i) => {
      if (i < (isDeep ? 3 : 2)) buckets.lead.push(s);
      else if (FACTS_HINT.test(s)) buckets.facts.push(s);
      else if (VOICE_HINT.test(s)) buckets.voices.push(s);
      else buckets.rest.push(s);
    });

    const opening = `${pick(type.meta.openings)} ${head || buckets.lead[0] || 'here is the latest'}.`;
    const closing = pick(type.meta.closings) + '.';
    const attribution = source ? ` Reported by ${source}.` : '';
    const chapters = [];
    const push = (title, parts) => {
      const text = pronounce(parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim());
      if (text) chapters.push({ title, text });
    };

    // transitions only lead into real content — never dangle alone
    const withTransition = (content) => (content.length ? [nextTransition() + '.', ...content] : []);

    if (!isDeep) {
      // Briefing — headline + key facts + wrap (≈60–120s)
      const facts = buckets.facts.slice(0, 3);
      const factsFill = facts.length ? facts : buckets.rest.slice(0, 2);
      push('Opening & the story', [opening, buckets.lead.slice(1, 3)]);
      push('Key facts', withTransition(factsFill));
      push('Wrap-up', [closing, attribution]);
    } else {
      // Deep dive — full broadcast structure (as long as the source allows)
      const facts = buckets.facts.slice(0, 4);
      const ctx = facts.length ? buckets.rest.slice(2, 8) : buckets.rest.slice(4, 10);
      push('Opening', [opening, buckets.lead.slice(1, 2)]);
      push('The story', [buckets.lead.slice(2), buckets.rest.slice(0, 2)]);
      push('Key facts & figures', withTransition(facts));
      push('Context & background', withTransition(ctx));
      if (buckets.voices.length) push('Voices & analysis', withTransition(buckets.voices.slice(0, 3)));
      push('Implications & closing', [closing, attribution]);
    }

    const script = chapters.map(c => c.text).join(' ');
    return {
      storyType: type.type,
      mode,
      words: wordCount(script),
      seconds: estimateSeconds(wordCount(script)),
      chapters,
      script,
    };
  }

  function dedupe(list) {
    const seen = new Set();
    const out = [];
    for (const s of list) {
      const k = s.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 64);
      if (k && !seen.has(k)) { seen.add(k); out.push(s); }
    }
    return out;
  }

  // Ultra-fast spoken line for instant feedback while the briefing prepares.
  function instantBriefing(title, snippet) {
    const type = detectStoryType(title, snippet);
    const head = cleanHeadline(title);
    const first = sentences(snippet)[0] || '';
    return pronounce(`${pick(type.meta.openings)} ${head}. ${first}`.trim());
  }

  // ────────────────────────── REPORT → CHAPTERS ──────────────────────────
  // Aurora research reports are fully owned content: split by markdown
  // headings into a narrated chapter structure.
  function reportChapters(markdown, title, mode) {
    const lines = String(markdown || '').split('\n');
    const chapters = [];
    let curTitle = 'Opening';
    let buf = [];
    const flush = () => {
      const text = cleanProse(buf.join('\n'));
      if (text) chapters.push({ title: curTitle, text });
      buf = [];
    };
    for (const line of lines) {
      const m = line.match(/^#{1,3}\s+(.+?)\s*$/);
      if (m) { flush(); curTitle = m[1].trim().replace(/\s*[:#]+\s*$/, ''); }
      else buf.push(line);
    }
    flush();

    const trimmed = chapters.map(c => ({
      title: c.title,
      text: c.text.slice(0, 2200),
    })).filter(c => wordCount(c.text) >= 2).slice(0, 8);

    if (trimmed.length >= 3) {
      const script = trimmed.map(c => pronounce(c.text)).join(' ');
      return { storyType: 'report', mode: mode || 'deep', chapters: trimmed, words: wordCount(script), seconds: estimateSeconds(wordCount(script)), script };
    }
    // No usable headings — fall back to the narrative builder
    return buildScript({ title: title || 'Research report', text: markdown, mode: mode || 'deep' });
  }

  // ────────────────────────── FEEDBACK & QUALITY LOOP ──────────────────────────
  const FB_KEY = 'aurora-narration-feedback';
  const METRICS_KEY = 'aurora-narration-metrics';

  const store = {
    get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
    set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* private mode */ } },
  };

  const ISSUES = ['Mispronunciation', 'Awkward phrasing', 'Wrong emphasis', 'Incorrect summary', 'Poor pacing'];

  function recordFeedback(kind, meta) {
    const list = store.get(FB_KEY, []);
    list.push({ kind, meta: meta || {}, at: Date.now() });
    store.set(FB_KEY, list.slice(-200));
    return list.length;
  }

  function reportIssue(issue, meta) {
    return recordFeedback('issue', { ...(meta || {}), issue });
  }

  // Quality learning loop: one session entry per listen (local, privacy-safe)
  function recordSession(entry) {
    const list = store.get(METRICS_KEY, []);
    list.push({ ...entry, at: Date.now() });
    store.set(METRICS_KEY, list.slice(-500));
    return list.length;
  }

  function metrics() {
    const list = store.get(METRICS_KEY, []);
    if (!list.length) return null;
    const done = list.filter(e => e.completed);
    return {
      sessions: list.length,
      completions: done.length,
      completionRate: done.length / list.length,
      avgSeconds: Math.round(list.reduce((n, e) => n + (e.seconds || 0), 0) / list.length),
      modes: list.reduce((m, e) => { m[e.mode || 'briefing'] = (m[e.mode || 'briefing'] || 0) + 1; return m; }, {}),
      thumbsUp: store.get(FB_KEY, []).filter(f => f.kind === 'helpful').length,
    };
  }

  // ── AI-assisted anchor script generation ──
  // Uses the AI provider chain for better phrasing; falls back to heuristic
  // buildScript when the AI is unreachable (offline, api down, etc.).
  // Builds a compact chaptered script by asking the AI to produce a broadcast
  // structure, then parses the response.
  async function buildAiScript({ title, source, text, mode, ai, settings }) {
    if (typeof ai !== 'object' || typeof ai.chat !== 'function') {
      return null;
    }
    const wordMax = mode === 'deep' ? 400 : 140;
    const truncated = String(text || '').trim().slice(0, 8000);
    if (truncated.length < 80) return null;

    const prompt = {
      system: `You are a professional broadcast news producer writing scripts for a narrator named Aurora. Write a natural-sounding broadcast script for the given article.

OUTPUT FORMAT — use plain text with this structure:

OPENING: [2-4 sentences — who/what/when, the hook]
STORY: [2-4 sentences — how it happened, key developments]
FACTS: [2-5 sentences — key numbers, data, figures. Keep numeric facts intact e.g. "$1.8 trillion"]
${mode === 'deep' ? 'CONTEXT: [3-5 sentences — background, what it means, opposing views]\nIMPLICATIONS: [2-4 sentences — what happens next]' : ''}
CLOSING: [1-3 sentences — forward-looking wrap]

RULES:
- Use plain conversational prose. NO markdown, NO bullet symbols, NO star characters.
- Write for the ear — short sentences, natural rhythm, varied sentence starts.
- Never repeat the transition style: vary "Turning now to...", "Looking at...", "Meanwhile" etc.
- Keep the total under ${wordMax} words.
- Never invent facts not in the article. If the article is thin, say so and summarize what is known.
- Attribute e.g. "Reported by ${source || 'our sources'}." at the end of CLOSING.
- Start directly with "OPENING:" — no preamble.`,
      user: `Title: ${title || 'Untitled'}
${source ? 'Source: ' + source + '\n' : ''}
Mode: ${mode === 'deep' ? 'deep dive (broadcast structure with context)' : 'briefing (headline, key facts, wrap)'}

Article text:
"""
${truncated}
"""

Write the broadcast script now.`,
    };

    try {
      let text = '';
      // Bounded AI pass: if the provider chain is slow/hung, the heuristic
      // fallback must kick in promptly instead of stalling playback behind
      // a multi-second "Preparing…" state.
      const out = await Promise.race([
        ai.chat(
          [{ role: 'user', content: `${prompt.system}\n\n${prompt.user}` }],
          (settings || ai.__settings || {}),
          { onChunk: chunk => { text += chunk; } },
        ),
        new Promise((_, reject) => setTimeout(() => reject(new Error('AI script timeout')), 12000)),
      ]);
      const full = (out && out.markdown) || text;
      if (!full || full.length < 60) return null;
      return parseAiScript(full, mode, title, source);
    } catch {
      return null;
    }
  }

  // Parse AI's broadcast script format back into the chapter array we use
  function parseAiScript(text, mode, title, source) {
    const map = {
      opening: 'Opening', story: 'The story', facts: 'Key facts & figures',
      context: 'Context & background', implications: 'Implications & closing',
      closing: 'Wrap-up',
    };
    const chapters = [];
    let cur = '';
    const lines = text.split('\n');
    for (const line of lines) {
      const m = line.match(/^(OPENING|STORY|FACTS|CONTEXT|IMPLICATIONS|CLOSING)\s*:/i);
      if (m) {
        if (cur.trim().length > 10 && chapters.length) chapters[chapters.length - 1].text += ' ' + cur.trim();
        else if (cur.trim().length > 10) chapters.push({ title: map[chapters.length === 0 ? 'opening' : 'facts'] || 'Section', text: cur.trim() });
        const key = m[1].toLowerCase();
        chapters.push({ title: map[key] || key, text: line.slice(m[0].length).trim() });
        cur = '';
      } else {
        cur += ' ' + line.trim();
      }
    }
    // flush last line
    if (cur.trim()) {
      if (chapters.length) chapters[chapters.length - 1].text += ' ' + cur.trim();
      else chapters.push({ title: 'Summary', text: cur.trim() });
    }
    // clean
    for (const c of chapters) {
      c.text = pronounce(cleanProse(c.text)).replace(/\s+/g, ' ').trim();
    }
    const filtered = chapters.filter(c => c.text.length > 15);
    if (filtered.length < 2) return null;

    const urlAttribution = source ? ` Reported by ${source}.` : '';
    if (urlAttribution && filtered.length && !filtered[filtered.length - 1].text.includes('Reported by')) {
      filtered[filtered.length - 1].text += urlAttribution;
    }

    const allText = filtered.map(c => c.text).join(' ');
    return {
      storyType: detectStoryType(title, text).type,
      mode,
      words: wordCount(allText),
      seconds: estimateSeconds(wordCount(allText)),
      chapters: filtered,
      script: allText,
      origin: 'ai',
    };
  }

  return {
    detectStoryType, stripBoilerplate, sentences, cleanProse, pronounce,
    buildScript, instantBriefing, reportChapters,
    buildAiScript, parseAiScript,
    wordCount, estimateSeconds,
    recordFeedback, reportIssue, recordSession, metrics, ISSUES,
  };
})();

// Node smoke-test hook (kept identical to test-tts.js loading style)
if (typeof module !== 'undefined' && module.exports) module.exports = Anchor;
