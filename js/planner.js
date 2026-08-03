/* ─────────────────────────────────────────────
   Aurora — Research Planner agent
   An autonomous research pipeline that runs BEFORE searching:

     1. Intent classification (informational / comparative / temporal /
        navigational / transactional / research)
     2. Research plan generation — AI-first, heuristic fallback
        (sub-questions + search queries per aspect, source strategy)
     3. Parallel search across plan aspects
     4. Knowledge-gap detection → targeted second-round searches
     5. Cross-source evidence analysis (consensus / single-source /
        contradictions) → report confidence

   Pure module: no DOM access, no top-level side effects (Node-testable).
   ───────────────────────────────────────────── */
const Planner = (() => {
  const MAX_ASPECTS = 4;       // round-1 parallel queries
  const MAX_GAP_FILLS = 2;     // round-2 targeted searches
  const MIN_ASPECTS = 2;

  // ── Preferred source mix per intent (overlaid with user-enabled sources) ──
  const INTENT_SOURCES = {
    informational: ['wikipedia', 'web', 'hackernews', 'news'],
    comparative:   ['web', 'wikipedia', 'news', 'academic'],
    temporal:      ['news', 'web', 'hackernews'],
    navigational:  ['web', 'wikipedia'],
    transactional: ['web', 'wikipedia'],
    research:      ['academic', 'wikipedia', 'web'],
  };

  const INTENT_LABELS = {
    informational: 'Informational', comparative: 'Comparative', temporal: 'Temporal',
    navigational: 'Navigational', transactional: 'Transactional', research: 'Research',
  };

  // ── 1. Intent classification (complements Search.detectType source routing) ──
  function classifyIntent(query) {
    const q = String(query || '').toLowerCase();
    if (/\b(vs|versus)\b|compare|comparison|difference between| or |alternative to/.test(q)) return 'comparative';
    if (/latest|breaking|today|this week|this month|news|update|timeline|history|trend|202\d/.test(q)) return 'temporal';
    if (/pricing|price page|login|sign in|download|docs|documentation|official site|website|how much does/.test(q)) return 'navigational';
    if (/buy|purchase|order|subscribe|sign up|get started|trial|free download|shop for/.test(q)) return 'transactional';
    if (/paper|study|research|literature|academic|scholarly|journal|survey of|state of the art|open questions/.test(q)) return 'research';
    return 'informational';
  }

  function intentLabel(intent) { return INTENT_LABELS[intent] || 'Research'; }

  // ── 2. Heuristic plan builder (deterministic, always available) ──
  function heuristicPlan(query, intent) {
    const q = String(query || '').trim();
    const i = intent || classifyIntent(q);
    let aspects = [];

    if (i === 'comparative') {
      const parts = q.split(/\s*\b(vs|versus| or | and )\b\s*/i).filter(Boolean);
      if (parts.length >= 2) {
        const [a, b] = [parts[0].trim(), parts.slice(1).join(' ').trim()];
        aspects = [
          { question: `Background of "${a}"`, queries: [a, `${a} key facts`] },
          { question: `Background of "${b}"`, queries: [b, `${b} key facts`] },
          { question: `Direct comparison: ${a} vs ${b}`, queries: [q, `${q} pros and cons`] },
        ];
      }
    }
    if (!aspects.length) {
      const defs = {
        temporal: [
          ['Historical background', [q, `${q} history timeline`]],
          ['Current status', [q, `${q} current status`]],
          ['Latest developments', [`${q} latest news`, `${q} update`]],
        ],
        research: [
          ['Academic literature', [`${q} research paper`, `${q} study`]],
          ['Authoritative overview', [q]],
          ['Expert analysis & open questions', [`${q} analysis review`, `${q} open questions`]],
        ],
        navigational: [
          ['Overview', [q]],
          ['Pricing & options', [`${q} pricing`, `${q} plans cost`]],
          ['Alternatives & reviews', [`${q} alternatives`, `${q} reviews`]],
        ],
        transactional: [
          ['Overview', [q]],
          ['Pricing & options', [`${q} pricing`, `${q} plans cost`]],
          ['Alternatives & reviews', [`${q} alternatives`, `${q} reviews`]],
        ],
        informational: [
          ['Overview & background', [q, `${q} background history`]],
          ['Key facts & data', [`${q} key facts statistics data`]],
          ['Recent developments', [`${q} latest news updates`]],
          ['Perspectives & debates', [`${q} criticism controversy analysis`]],
        ],
      };
      aspects = (defs[i] || defs.informational).map(([question, queries]) => ({ question, queries }));
    }

    return {
      intent: i,
      intentLabel: INTENT_LABELS[i] || 'Research',
      title: `Research plan: ${q.slice(0, 80)}`,
      origin: 'heuristic',
      aspects: aspects.map((a, n) => normalizeAspect({ ...a, id: 'a' + (n + 1) }, i)),
    };
  }

  function normalizeAspect(a, intent) {
    return {
      id: a.id || 'a' + Math.floor(Math.random() * 1e6),
      question: String(a.question || 'Research this aspect').slice(0, 140),
      queries: (Array.isArray(a.queries) ? a.queries : [String(a.queries || '')])
        .map(q => String(q || '').trim().replace(/\s+/g, ' ').slice(0, 120))
        .filter(Boolean)
        .slice(0, 3),
      sources: Array.isArray(a.sources) && a.sources.length ? a.sources : (INTENT_SOURCES[intent] || INTENT_SOURCES.informational),
    };
  }

  // ── 3. AI plan generation with heuristic fallback ──
  async function plan(query, settings) {
    const intent = classifyIntent(query);
    let aiPlan = null;
    if (typeof AI !== 'undefined' && typeof AI.planResearch === 'function') {
      try {
        aiPlan = await AI.planResearch(query, settings);
      } catch { aiPlan = null; }
    }
    let result = aiPlan && Array.isArray(aiPlan.aspects) && aiPlan.aspects.length >= MIN_ASPECTS
      ? aiPlan
      : heuristicPlan(query, intent);

    // Normalize + enforce limits regardless of origin
    const finalIntent = result.intent || intent;
    result = {
      ...result,
      intent: finalIntent,
      intentLabel: result.intentLabel || INTENT_LABELS[finalIntent] || 'Research',
      origin: (aiPlan && Array.isArray(aiPlan.aspects) && aiPlan.aspects.length >= MIN_ASPECTS) ? 'ai' : 'heuristic',
      aspects: (result.aspects || []).map((a, n) => normalizeAspect({ ...a, id: a.id || 'a' + (n + 1) }, finalIntent)).slice(0, MAX_ASPECTS),
    };
    if (result.aspects.length < MIN_ASPECTS) {
      result.aspects = heuristicPlan(query, finalIntent).aspects.slice(0, MAX_ASPECTS);
    }
    return result;
  }

  // Intersect the intent's preferred sources with the user's enabled set,
  // always keeping wikipedia + web when enabled (safety net).
  function sourceOverlay(preferred, enabled) {
    const allowed = Object.keys(enabled || {}).filter(k => enabled[k]);
    const prefs = (preferred || []).filter(s => allowed.includes(s));
    const always = ['wikipedia', 'web'].filter(s => allowed.includes(s) && !prefs.includes(s));
    const out = {};
    for (const s of allowed) out[s] = false;
    for (const s of [...prefs, ...always]) out[s] = true;
    return out;
  }

  // ── 4. Parallel search across aspects ──
  async function searchAspects(plan, settings, handlers) {
    const sub = { ...settings, perSource: Math.min(4, Math.max(2, Number(settings.perSource || 8) - 3)) };
    const byAspect = {};
    const errors = [];
    await Promise.all(plan.aspects.map(async (a, i) => {
      a.status = 'searching';
      if (handlers.onAspect) handlers.onAspect(a, i, 'searching');
      try {
        const res = await Search.run(a.queries[0], {
          ...sub,
          sources: sourceOverlay(a.sources, settings.sources),
        });
        byAspect[a.id] = res.results || [];
        a.status = 'done';
        a.resultCount = byAspect[a.id].length;
        if (handlers.onAspect) handlers.onAspect(a, i, 'done');
      } catch (e) {
        a.status = 'error';
        a.resultCount = 0;
        errors.push({ aspect: a.id, message: e.message });
        if (handlers.onAspect) handlers.onAspect(a, i, 'error');
      }
    }));
    return { byAspect, errors };
  }

  // ── 5. Knowledge-gap detection ──
  function isRecent(r, days = 45) {
    return !!(r && r.publishedAt && (Date.now() - r.publishedAt) < days * 86400000);
  }

  function assessGaps(plan, byAspect) {
    const gaps = [];
    for (const a of plan.aspects) {
      const items = byAspect[a.id] || [];
      if (!items.length) {
        gaps.push({ aspectId: a.id, reason: 'no results found', severity: 2 });
      } else if (items.length < 2) {
        gaps.push({ aspectId: a.id, reason: 'coverage too thin (1 result)', severity: 1 });
      } else if (plan.intent === 'temporal' && !items.some(isRecent)) {
        gaps.push({ aspectId: a.id, reason: 'no recent sources for a time-sensitive query', severity: 1 });
      }
    }
    return gaps.sort((x, y) => y.severity - x.severity);
  }

  // ── 6. Targeted second round for the worst gaps (capped) ──
  async function fillGaps(plan, gaps, byAspect, settings, handlers) {
    const sub = { ...settings, perSource: Math.min(5, Math.max(2, Number(settings.perSource || 8) - 2)) };
    const filled = [];
    for (const gap of gaps.slice(0, MAX_GAP_FILLS)) {
      const a = plan.aspects.find(x => x.id === gap.aspectId);
      if (!a || !a.queries[1]) continue;
      if (handlers.onGap) handlers.onGap(gap, a);
      try {
        a.status = 'searching';
        if (handlers.onAspect) handlers.onAspect(a, plan.aspects.indexOf(a), 'searching');
        const res = await Search.run(a.queries[1], {
          ...sub,
          sources: sourceOverlay(a.sources, settings.sources),
        });
        byAspect[a.id] = dedupe([...(byAspect[a.id] || []), ...(res.results || [])]);
        a.resultCount = byAspect[a.id].length;
        a.gapFilled = true;
        a.status = 'done';
        filled.push(a.id);
        if (handlers.onAspect) handlers.onAspect(a, plan.aspects.indexOf(a), 'done');
      } catch { /* keep round-1 results */ }
    }
    return filled;
  }

  // ── Dedupe by normalized title + url, first occurrence wins ──
  function dedupe(results) {
    const seen = new Set();
    const out = [];
    for (const r of results || []) {
      const key = (r.title || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80) + '|' + (r.url || '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
    return out;
  }

  // ── 7. Cross-source evidence analysis ──
  const STOP = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'is', 'are', 'was', 'be', 'by', 'with', 'from', 'as', 'its', 'it', 'this', 'that']);
  function titleKey(title) {
    return String(title || '').toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP.has(w))
      .slice(0, 6)
      .join(' ');
  }
  function domainOf(url) {
    try { return String(url || '').replace(/^[a-z]+:\/\//i, '').split('/')[0].split(':')[0].toLowerCase(); } catch { return ''; }
  }

  const STANCE_PAIRS = [
    ['approves', 'rejects'], ['raises', 'cuts'], ['wins', 'loses'], ['gains', 'falls'],
    ['growth', 'decline'], ['increases', 'decreases'], ['supports', 'opposes'],
    ['passes', 'blocks'], ['profit', 'loss'], ['bullish', 'bearish'], ['up', 'down'],
  ];
  function detectContradiction(cluster) {
    const text = cluster.map(c => `${c.title || ''} ${c.snippet || ''}`.toLowerCase()).join(' ');
    for (const [a, b] of STANCE_PAIRS) {
      if (text.includes(a) && text.includes(b)) return `${a}/${b}`;
    }
    return null;
  }

  function evidence(results) {
    const list = dedupe(results || []);
    const clusters = [];
    const used = new Set();
    for (let i = 0; i < list.length; i++) {
      if (used.has(i)) continue;
      const key = titleKey(list[i].title);
      const members = [list[i]];
      used.add(i);
      for (let j = i + 1; j < list.length; j++) {
        if (used.has(j)) continue;
        if (key && titleKey(list[j].title) === key) { members.push(list[j]); used.add(j); }
      }
      clusters.push(members);
    }

    // Score every cluster, then aggregate confidence across ALL of them
    // (only the top clusters are shown in the UI).
    const scoredAll = clusters
      .filter(c => c.length)
      .map(c => {
        const domains = new Set(c.map(r => domainOf(r.url)).filter(Boolean));
        const tiers = new Set(c.map(r => (typeof Trust !== 'undefined' && Trust.score) ? Trust.score(r).tier : 3));
        const srcTypes = new Set(c.map(r => r.source));
        let confidence = 0.30 + 0.20 * Math.min(3, domains.size) +
          (tiers.has(1) ? 0.25 : 0) + (tiers.has(2) ? 0.15 : 0);
        if (c.some(isRecent)) confidence += 0.08;
        const contradiction = detectContradiction(c);
        if (contradiction) confidence = Math.min(confidence, 0.5); // conflicting signals cap
        confidence = Math.round(Math.min(0.95, confidence) * 100) / 100;
        return {
          title: (c[0].title || 'Untitled').slice(0, 100),
          count: c.length,
          domains: domains.size,
          sources: srcTypes.size,
          tiers: [...tiers],
          confidence,
          consensus: domains.size >= 2,
          singleSource: domains.size <= 1,
          contradiction,
          urls: c.slice(0, 3).map(x => x.url),
        };
      });

    const total = list.length || 1;
    const confidence = total
      ? Math.round(Math.min(0.95, scoredAll.reduce((acc, c) => acc + c.confidence * c.count, 0) / total) * 100) / 100
      : 0;
    const scored = scoredAll.sort((a, b) => b.count - a.count).slice(0, 6);

    // Aggregate stats consumed by the verdict engine
    const consensusResults = scoredAll.filter(c => c.consensus).reduce((a, c) => a + c.count, 0);
    const contradictionResults = scoredAll.filter(c => c.contradiction).reduce((a, c) => a + c.count, 0);
    const singleResults = scoredAll.filter(c => c.singleSource).reduce((a, c) => a + c.count, 0);
    let avgTier = 3;
    if (list.length && typeof Trust !== 'undefined' && Trust.score) {
      avgTier = list.reduce((a, r) => a + Trust.score(r).tier, 0) / list.length;
    }

    return {
      clusters: scored,
      confidence,
      consensusCount: scored.filter(c => c.consensus).length,
      singleSourceCount: scored.filter(c => c.singleSource).length,
      contradictionCount: scored.filter(c => c.contradiction).length,
      stats: {
        totalClusters: scoredAll.length,
        avgTier,
        recencyFraction: total ? list.filter(isRecent).length / total : 0,
        consensusFraction: total ? consensusResults / total : 0,
        contradictionFraction: total ? contradictionResults / total : 0,
        singleSourceFraction: total ? singleResults / total : 0,
      },
    };
  }

  function confidenceLevel(confidence) {
    if (confidence >= 0.7) return { label: 'High confidence', emoji: '🟢', color: 'green' };
    if (confidence >= 0.45) return { label: 'Medium confidence', emoji: '🟡', color: 'yellow' };
    return { label: 'Low confidence', emoji: '🔴', color: 'red' };
  }

  // ── Limitations summary for the Research Process panel ──
  function buildLimitations(plan, gaps, errors, resultCount) {
    const lines = [];
    if (!resultCount) lines.push('No search results were returned — the report may lean on general knowledge.');
    if (gaps.length) {
      const names = gaps.map(g => {
        const a = plan.aspects.find(x => x.id === g.aspectId);
        return a ? a.question : null;
      }).filter(Boolean);
      if (names.length) lines.push(`Coverage was thin for: ${names.join('; ')}.`);
    }
    if (errors.length) lines.push(`${errors.length} search source(s) were unreachable during this run.`);
    if (plan.origin === 'heuristic') lines.push('The research plan was generated by heuristics (AI planner unavailable or offline).');
    return lines;
  }

  // ── 8. Orchestrator: plan → parallel search → gaps → evidence ──
  async function runResearch(query, settings, handlers = {}) {
    const started = Date.now();
    if (handlers.onStage) handlers.onStage('plan');
    const planResult = await plan(query, settings);
    if (handlers.onPlan) handlers.onPlan(planResult);

    if (handlers.onStage) handlers.onStage('search');
    const { byAspect, errors } = await searchAspects(planResult, settings, handlers);

    if (handlers.onStage) handlers.onStage('gaps');
    const gaps = assessGaps(planResult, byAspect);
    const filled = await fillGaps(planResult, gaps, byAspect, settings, handlers);
    if (filled.length && handlers.onGapsFilled) handlers.onGapsFilled(filled);

    if (handlers.onStage) handlers.onStage('merge');
    const tagged = [];
    for (const a of planResult.aspects) {
      for (const r of byAspect[a.id] || []) tagged.push({ ...r, aspect: a.id });
    }
    const results = dedupe(tagged);
    const ev = evidence(results);
    const limitations = buildLimitations(planResult, gaps, errors, results.length);

    return {
      plan: planResult,
      results,
      byAspect,
      errors,
      gaps,
      evidence: ev,
      confidence: ev.confidence,
      limitations,
      stats: {
        queriesRun: planResult.aspects.length + filled.length,
        gapsFound: gaps.length,
        gapsFilled: filled.length,
        durationMs: Date.now() - started,
      },
    };
  }

  return {
    classifyIntent, intentLabel, heuristicPlan, plan, sourceOverlay,
    searchAspects, assessGaps, fillGaps, dedupe, titleKey, isRecent,
    evidence, confidenceLevel, buildLimitations, runResearch,
    INTENT_SOURCES, MAX_ASPECTS, MAX_GAP_FILLS,
  };
})();
