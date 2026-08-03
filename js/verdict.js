/* ─────────────────────────────────────────────
   Aurora — Research Verdict Engine
   The final layer above search, synthesis and verification.
   Turns research results into evidence-based conclusions with
   quantified confidence — while never hiding uncertainty.

   PRINCIPLES:
   - Confidence is COMPUTED from evidence (never guessed by an LLM).
   - Never claim certainty. Never present speculation as fact.
   - Contradictions, unknowns and assumptions are always surfaced.
   - Every verdict explains what could change it (basis for monitoring).

   Pure module: no DOM, no top-level side effects (Node-testable).
   ───────────────────────────────────────────── */
const Verdict = (() => {
  const VERDICT_VERSION = 1;

  // ── 1. Question analysis ──
  const POS_HINTS = ['benefit', 'good idea', 'worth it', 'profit', 'grow', 'growth', 'succeed', 'success', 'win', 'improve', 'best', 'opportunity', 'adopt', 'outperform', 'gain', 'rally', 'recover', 'boom', 'beat', 'strengthen', 'upgrade'];
  const NEG_HINTS = ['risky', 'risk', 'bad idea', 'decline', 'fail', 'failure', 'lose', 'loss', 'crash', 'bubble', 'waste', 'not worth', 'crisis', 'dangerous', 'threat', 'threaten', 'downside', 'drop', 'fall'];

  // Direction of the question's implied outcome: 'positive' | 'negative' | null
  function detectPolarity(query) {
    const q = String(query || '').toLowerCase();
    let pos = 0, neg = 0;
    for (const w of POS_HINTS) if (q.includes(w)) pos++;
    for (const w of NEG_HINTS) if (q.includes(w)) neg++;
    if (pos > neg) return 'positive';
    if (neg > pos) return 'negative';
    return null;
  }

  function isDecisionQuery(query) {
    return /\b(should (i|we|you|someone)|worth it|invest(ing|ment)? in|buy |buying|upgrade|switch to|adopt|pay for|sign up|get into|risk)\b/i.test(String(query || ''));
  }

  function isYesNoQuery(query) {
    return /^(will|is|are|does|do|can|could|would|should|did|has|have)\b/i.test(String(query || '').trim());
  }

  // ── 2. Evidence sentiment & item classification ──
  const POSITIVE_RE = /(grow|growth|rise|rises|rising|gain|gains|profit|profitable|profitability|success|succeed|win|wins|approve|approval|boost|boosted|improve|improvement|increase|recover|rally|outperform|boom|expand|beat|exceed|record|highest|strong|bullish|positive|surge|soar|surpass|advantage|leader|leading|demand|expansion)/gi;
  const NEGATIVE_RE = /(fall|falls|decline|drop|drops|loss|loses|losses|crash|collapse|ban|bans|reject|rejection|risk|risky|penalty|penalties|hurt|suffer|worse|decrease|block|blocks|oppose|opposition|threat|threaten|struggle|underperform|weak|bearish|negative|plunge|tumble|layoff|layoffs|lawsuit|antitrust|sanction|crisis|downturn|shrink)/gi;

  // Positive = supporting the "positive" reading; negative = contradicting it.
  function sentimentScore(text) {
    const t = String(text || '');
    const pos = (t.match(POSITIVE_RE) || []).length;
    const neg = (t.match(NEGATIVE_RE) || []).length;
    return pos - neg;
  }

  // Safety: tag every evidence item as Fact / Inference / Speculation
  const FACT_RE = /\b(19|20)\d{2}\b|\$\s?\d|\d+(\.\d+)?%|\b(according to|reported|announced|published|said|stated|raised|launched|confirmed|filed|released|earned|paid|hit|reached)\b/i;
  const SPECULATION_RE = /\b(may|might|could|possibly|expected|estimate|estimated|projected|likely|unlikely|analysts (say|expect|forecast)|forecast|predict|anticipated|rumored|reportedly planning|plans to)\b/i;
  function classifyEvidenceItem(text) {
    const t = String(text || '');
    if (SPECULATION_RE.test(t) && !FACT_RE.test(t)) return 'speculation';
    if (FACT_RE.test(t)) return 'fact';
    return 'inference';
  }

  // ── 3. Confidence scoring — computed from evidence, never guessed ──
  const clamp01 = x => Math.max(0, Math.min(1, x));

  function scoreConfidence(stats = {}) {
    const quality = clamp01(1 - ((stats.avgTier == null ? 3 : stats.avgTier) - 1) / 3);
    const agreement = clamp01(1 - (stats.contradictionFraction || 0) * 2.2);
    const consensus = clamp01(stats.consensusFraction || 0);
    const count = clamp01((stats.totalClusters || 0) / 8);
    const recency = clamp01(stats.recencyFraction || 0);
    const c = 0.30 * quality + 0.20 * agreement + 0.20 * consensus + 0.15 * count + 0.15 * recency;
    return Math.round(clamp01(c) * 100);
  }

  function scoreEvidenceStrength(stats = {}) {
    const quality = clamp01(1 - ((stats.avgTier == null ? 3 : stats.avgTier) - 1) / 3);
    const count = clamp01((stats.totalClusters || 0) / 8);
    const recency = clamp01(stats.recencyFraction || 0);
    const diversity = clamp01(1 - (stats.singleSourceFraction || 1));
    const s = 0.40 * quality + 0.20 * count + 0.20 * recency + 0.20 * diversity;
    return Math.round(clamp01(s) * 100);
  }

  function confidenceLabel(confidence) {
    if (confidence >= 70) return 'High';
    if (confidence >= 40) return 'Moderate';
    return 'Low';
  }

  // ── 4. Verdict classification ──
  const VERDICT_LABELS = {
    likely_yes: 'Likely Yes',
    likely_no: 'Likely No',
    unclear: 'Unclear',
    mixed: 'Mixed signal',
    insufficient_evidence: 'Insufficient evidence',
  };

  function verdictLabel(type) { return VERDICT_LABELS[type] || 'Unclear'; }

  function classifyVerdict(confidence, supportCount, contraCount, decision, polarity) {
    if (confidence < 40) return 'insufficient_evidence';
    const total = supportCount + contraCount;
    if (contraCount >= 2 && contraCount / Math.max(1, total) >= 0.35) return 'mixed';
    if (decision || !polarity) {
      if (total < 2) return 'insufficient_evidence';
      const ratio = supportCount / total;
      if (ratio >= 0.7) return 'likely_yes';
      if (ratio <= 0.3) return 'likely_no';
      return 'unclear';
    }
    if (total < 2) return 'insufficient_evidence';
    if (supportCount === contraCount) return 'unclear';
    return supportCount > contraCount ? 'likely_yes' : 'likely_no';
  }

  // ── 5. Uncertainty helpers ──
  const TRIGGER_TOPICS = [
    ['regulation', 'New regulation or policy'],
    ['policy', 'New regulation or policy'],
    ['law', 'Legislation or court ruling'],
    ['court', 'Legislation or court ruling'],
    ['lawsuit', 'Legal action or settlement'],
    ['earnings', 'Earnings or financial results'],
    ['deal', 'Major deal or acquisition'],
    ['acquisition', 'Major deal or acquisition'],
    ['launch', 'Product launch or release'],
    ['breakthrough', 'Scientific or technical breakthrough'],
    ['election', 'Election or political change'],
    ['tariff', 'Tariffs or trade policy'],
    ['export', 'Export controls or trade policy'],
    ['sanction', 'Sanctions or geopolitical shift'],
    ['data', 'New official data or report'],
    ['report', 'New official data or report'],
  ];

  function whatCouldChangeThis(results = []) {
    const text = results.map(r => `${r.title || ''} ${r.snippet || ''}`.toLowerCase()).join(' ');
    const found = new Set();
    for (const [key, label] of TRIGGER_TOPICS) {
      if (text.includes(key)) found.add(label);
      if (found.size >= 4) break;
    }
    if (!found.size) found.add('New major developments');
    found.add('Contradicting evidence from multiple independent sources');
    return [...found].slice(0, 5);
  }

  function unknownFactors(ev = {}, query, decision) {
    const stats = ev.stats || {};
    const out = [];
    if ((stats.totalClusters || 0) < 3) out.push('Only a few evidence clusters were found — the picture may be incomplete.');
    if ((stats.singleSourceFraction || 1) > 0.4) out.push('Several claims rest on a single source and need independent confirmation.');
    if ((stats.recencyFraction || 0) < 0.3) out.push('Much of the evidence is not recent — conditions may have changed.');
    if (decision) out.push('Your personal situation and risk tolerance are not factored in.');
    out.push('Future developments could shift the answer.');
    return out.slice(0, 5);
  }

  function assumptions(decision) {
    const out = ['Sources consulted accurately represent the current landscape.'];
    if (decision) out.push('This verdict informs decisions but never guarantees outcomes.');
    out.push('No major unobserved events are assumed.');
    return out;
  }

  // ── 6. Main entry: compute a full ResearchVerdict from evidence ──
  function computeVerdict({ query, results, evidence }) {
    const list = (results || []);
    const ev = evidence || (typeof Planner !== 'undefined' ? Planner.evidence(list) : null) || {};
    const stats = ev.stats || {};
    const confidence = scoreConfidence(stats);
    const evidenceStrength = scoreEvidenceStrength(stats);
    const polarity = detectPolarity(query);
    const decision = isDecisionQuery(query);

    // Which side of the evidence agrees with the question's implied direction?
    const clusters = ev.clusters || [];
    const tagged = clusters.map(c => ({ ...c, sentiment: sentimentScore(`${c.title || ''} ${(c.urls || []).join(' ')}`) }));
    const agreesWith = x => (polarity === 'negative' ? x < 0 : x > 0);
    const contradictsDir = x => (polarity === 'negative' ? x > 0 : x < 0);
    const supporting = tagged.filter(c => agreesWith(c.sentiment)).sort((a, b) => b.sentiment - a.sentiment);
    const contradicting = tagged.filter(c => contradictsDir(c.sentiment)).sort((a, b) => a.sentiment - b.sentiment);
    const supportCount = supporting.length;
    const contraCount = contradicting.length;

    const verdictType = classifyVerdict(confidence, supportCount, contraCount, decision, polarity);
    const supportingEvidence = supporting.slice(0, 4).map(c => c.title);
    const contradictingEvidence = contradicting.slice(0, 4).map(c => c.title);

    const qualityNote = stats.avgTier <= 1.7 ? 'a strong mix of authoritative and established sources'
      : stats.avgTier <= 2.5 ? 'a mix of established and general sources'
      : 'mostly general or user-generated sources';
    const uncertaintyNotes = [];
    if ((stats.contradictionFraction || 0) > 0.2) uncertaintyNotes.push('contradictions between sources reduce confidence');
    if ((stats.recencyFraction || 0) < 0.3) uncertaintyNotes.push('much of the evidence is not recent');
    if ((stats.singleSourceFraction || 1) > 0.4) uncertaintyNotes.push('several claims rely on single sources');
    if (!uncertaintyNotes.length) uncertaintyNotes.push('no major red flags were found in the evidence');

    const directionLabel = polarity === 'negative' ? 'negative' : polarity === 'positive' ? 'positive' : 'neutral';
    const reasoningSummary =
      `Based on ${list.length} source${list.length === 1 ? '' : 's'} across ${stats.totalClusters || 0} evidence cluster${(stats.totalClusters || 0) === 1 ? '' : 's'}, ` +
      `${supportCount} support${supportCount === 1 ? 's' : ''} the ${directionLabel} reading while ${contraCount} conflict${contraCount === 1 ? 's' : ''} with it. ` +
      `Confidence is ${confidence}% (${confidenceLabel(confidence)}), driven by ${qualityNote}; ${uncertaintyNotes.join(', ')}.`;

    return {
      query,
      answer: verdictLabel(verdictType),
      verdictType,
      confidence,
      confidenceLabel: confidenceLabel(confidence),
      evidenceStrength,
      supportingEvidence,
      contradictingEvidence,
      unknownFactors: unknownFactors(ev, query, decision),
      assumptions: assumptions(decision),
      reasoningSummary,
      whatCouldChangeThis: whatCouldChangeThis(list),
      // Decision support (only meaningful for decision-style questions)
      pros: supporting.slice(0, 3).map(c => c.title),
      cons: contradicting.slice(0, 3).map(c => c.title),
      risks: tagged.filter(c => c.sentiment < 0).slice(0, 3).map(c => c.title),
      opportunities: tagged.filter(c => c.sentiment > 0).slice(0, 3).map(c => c.title),
      decisionQuery: decision,
      factLabels: {},
      generatedAt: new Date().toISOString(),
      verdictVersion: VERDICT_VERSION,
    };
  }

  // Classify the qualitative lists for the UI (Fact / Inference / Speculation)
  function tagItems(v) {
    const map = {};
    for (const item of [...(v.supportingEvidence || []), ...(v.contradictingEvidence || [])]) {
      map[item] = classifyEvidenceItem(item);
    }
    v.factLabels = map;
    return v;
  }

  // ── 7. Change detection for monitoring ──
  function detectChange(oldSnapshot, newV) {
    const oldType = oldSnapshot.verdictType || oldSnapshot.verdict || 'unclear';
    const oldConf = oldSnapshot.confidence || 0;
    const changed = oldType !== newV.verdictType || Math.abs(oldConf - (newV.confidence || 0)) >= 15;
    if (!changed) return { changed: false, reason: '' };
    const parts = [];
    if (oldType !== newV.verdictType) parts.push(`verdict shifted from ${verdictLabel(oldType)} to ${verdictLabel(newV.verdictType)}`);
    if (Math.abs(oldConf - (newV.confidence || 0)) >= 10) parts.push(`confidence moved ${oldConf}% → ${newV.confidence}%`);
    if (!parts.length) parts.push('the evidence picture shifted on re-evaluation');
    return {
      changed: true,
      reason: parts.join('; '),
      oldVerdict: oldType,
      newVerdict: newV.verdictType,
      oldConfidence: oldConf,
      newConfidence: newV.confidence || 0,
    };
  }

  // ── 8. Optional AI enrichment (qualitative lists only — confidence stays evidence-derived) ──
  async function enhance(query, results, verdict, settings) {
    if (typeof AI === 'undefined' || typeof AI.verdictAnalysis !== 'function') return verdict;
    try {
      const enriched = await AI.verdictAnalysis(query, results, settings);
      if (!enriched) return verdict;
      const pick = (cur, next) => (Array.isArray(next) && next.length) ? next.filter(Boolean).slice(0, 5) : cur;
      const next = {
        ...verdict,
        answer: typeof enriched.answer === 'string' && enriched.answer.trim() ? enriched.answer.trim().slice(0, 60) : verdict.answer,
        reasoningSummary: typeof enriched.reasoningSummary === 'string' && enriched.reasoningSummary.trim() ? enriched.reasoningSummary.trim().slice(0, 600) : verdict.reasoningSummary,
        supportingEvidence: pick(verdict.supportingEvidence, enriched.supportingEvidence),
        contradictingEvidence: pick(verdict.contradictingEvidence, enriched.contradictingEvidence),
        unknownFactors: pick(verdict.unknownFactors, enriched.unknownFactors),
        assumptions: pick(verdict.assumptions, enriched.assumptions),
        whatCouldChangeThis: pick(verdict.whatCouldChangeThis, enriched.whatCouldChangeThis),
        pros: pick(verdict.pros, enriched.pros),
        cons: pick(verdict.cons, enriched.cons),
        risks: pick(verdict.risks, enriched.risks),
        opportunities: pick(verdict.opportunities, enriched.opportunities),
        enhancedByAI: true,
      };
      return tagItems(next);
    } catch {
      return verdict;
    }
  }

  return {
    computeVerdict, tagItems, detectPolarity, isDecisionQuery, isYesNoQuery,
    sentimentScore, classifyEvidenceItem, scoreConfidence, scoreEvidenceStrength,
    confidenceLabel, classifyVerdict, verdictLabel, whatCouldChangeThis,
    unknownFactors, assumptions, detectChange, enhance, VERDICT_VERSION,
  };
})();
