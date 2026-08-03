// Quick smoke test for the Aurora research planner + trust engine (runs in Node)
const fs = require('fs');
const srcTrust = fs.readFileSync('js/trust.js', 'utf8');
const srcPlanner = fs.readFileSync('js/planner.js', 'utf8');
const Trust = new Function(srcTrust + '\nreturn Trust;')();
const Planner = new Function(srcTrust + '\n' + srcPlanner + '\nreturn Planner;')();

let pass = 0;
const TOTAL = 48;
const check = (name, cond) => { pass += cond ? 1 : 0; console.log(cond ? 'PASS:' : 'FAIL:', name); };
let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  console.log(`\n${pass}/${TOTAL} tests passed`);
  process.exit(pass === TOTAL ? 0 : 1);
}

// ── 1. Trust tiers ──
check('tierFor nih.gov → T1', Trust.tierFor('https://www.nih.gov/grants') === 1);
check('tierFor who.int → T1', Trust.tierFor('https://who.int/news') === 1);
check('tierFor reuters → T2', Trust.tierFor('https://reuters.com/world') === 2);
check('tierFor bbc.co.uk suffix → T2', Trust.tierFor('https://www.bbc.co.uk/news') === 2);
check('tierFor reddit → T4', Trust.tierFor('https://www.reddit.com/r/tech') === 4);
check('tierFor unknown → T3', Trust.tierFor('https://example-site.com/x') === 3);
check('tierFor .edu TLD → T1', Trust.tierFor('https://web.mit.edu/research') === 1);
check('tierFor .gov TLD → T1', Trust.tierFor('https://data.gov/dataset') === 1);
check('tierFor empty → T3', Trust.tierFor('') === 3);

const t1 = Trust.score({ url: 'https://www.nih.gov/x', title: 't', snippet: 'a reasonably long snippet here for testing', publishedAt: Date.now() });
check('T1 score is high confidence', t1.tier === 1 && t1.credibility >= 80 && t1.color === 'green');
const t4 = Trust.score({ url: 'https://www.reddit.com/r/x', title: 't', snippet: 'short' });
check('T4 score is low confidence', t4.tier === 4 && t4.credibility < 60 && t4.color === 'red');
check('score includes label + emoji', typeof t1.label === 'string' && typeof t1.emoji === 'string');
check('dated source scores higher', Trust.score({ url: 'https://reuters.com/a', publishedAt: Date.now() }).credibility > Trust.score({ url: 'https://reuters.com/a' }).credibility);

// ── 2. Intent classification ──
check('classifies comparative (vs)', Planner.classifyIntent('Claude vs GPT 5') === 'comparative');
check('classifies comparative (versus)', Planner.classifyIntent('Android versus iOS') === 'comparative');
check('classifies temporal (latest news)', Planner.classifyIntent('Latest OpenAI news') === 'temporal');
check('classifies temporal (history)', Planner.classifyIntent('history of the Roman Empire') === 'temporal');
check('classifies navigational (pricing)', Planner.classifyIntent('OpenAI API pricing') === 'navigational');
check('classifies research (papers)', Planner.classifyIntent('research paper on quantum error correction') === 'research');
check('classifies informational default', Planner.classifyIntent('What is AGI?') === 'informational');

// ── 3. Heuristic plan builder ──
const hp = Planner.heuristicPlan('quantum computing advances', 'informational');
check('heuristic plan has 3+ aspects', hp.aspects.length >= 3);
check('aspects have question + queries', hp.aspects.every(a => a.question && Array.isArray(a.queries) && a.queries.length >= 1));
check('aspect queries under 120 chars', hp.aspects.every(a => a.queries.every(q => q.length <= 120)));

const cmp = Planner.heuristicPlan('Tesla vs Ford', 'comparative');
check('comparative plan splits entities', cmp.aspects.length >= 3 && cmp.aspects.some(a => a.question.includes('Direct comparison')));

const tPl = Planner.heuristicPlan('latest AI news', 'temporal');
check('temporal plan covers latest developments', tPl.aspects.some(a => /latest/i.test(a.question)));

// ── 4. Dedupe ──
check('dedupe removes exact duplicates', Planner.dedupe([{ title: 'A', url: 'u' }, { title: 'A', url: 'u' }, { title: 'B', url: 'u2' }]).length === 2);
check('dedupe keeps distinct urls', Planner.dedupe([{ title: 'Same', url: 'a' }, { title: 'Same', url: 'b' }]).length === 2);

// ── 5. Gap detection ──
const gapPlan = { aspects: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }], intent: 'informational' };
const byAspect = { a1: [], a2: [{ title: 'x', url: 'u' }], a3: [{ title: 'x', url: 'u' }, { title: 'y', url: 'v' }] };
const gaps = Planner.assessGaps(gapPlan, byAspect);
check('gap detection flags empty aspects', gaps.length === 2 && gaps.some(g => g.aspectId === 'a1' && g.severity === 2));
check('gap detection flags thin aspects', gaps.some(g => g.aspectId === 'a2' && g.severity === 1));
check('gap detection leaves full aspects alone', !gaps.some(g => g.aspectId === 'a3'));

const tGap = Planner.assessGaps({ aspects: [{ id: 'a1' }], intent: 'temporal' }, { a1: [{ title: 'x', url: 'u', publishedAt: null }, { title: 'y', url: 'v', publishedAt: null }] });
check('temporal intent flags stale coverage', tGap.length === 1);

check('isRecent true for fresh timestamps', Planner.isRecent({ publishedAt: Date.now() - 1000 }) === true);
check('isRecent false for old timestamps', Planner.isRecent({ publishedAt: Date.now() - 200 * 86400000 }) === false);
check('isRecent false without date', Planner.isRecent({}) === false);

// ── 6. Evidence / cross-source verification ──
check('titleKey strips stopwords', Planner.titleKey('The Impact of AI on Healthcare') === Planner.titleKey('Impact of AI on Healthcare'));

const evCons = Planner.evidence([
  { title: 'Tech Giant Reports Record Revenue', url: 'https://www.reuters.com/x', snippet: 'Revenue hit one hundred billion dollars.', source: 'news', publishedAt: Date.now() },
  { title: 'Tech Giant Reports Record Revenue', url: 'https://www.bbc.co.uk/x', snippet: 'The company posted record revenue.', source: 'news', publishedAt: Date.now() },
]);
check('consensus cluster detected across domains', evCons.clusters.length >= 1 && evCons.clusters[0].consensus === true && evCons.clusters[0].domains >= 2);
check('high confidence for multi-source consensus', evCons.confidence >= 0.7);

const evSingle = Planner.evidence([{ title: 'Lone Claim About a Thing', url: 'https://medium.com/x', snippet: 'Some claim here.', source: 'web' }]);
check('single-source claim flagged', evSingle.clusters[0].singleSource === true && evSingle.clusters[0].consensus === false);
check('single low-tier source gets medium-low confidence', evSingle.confidence < 0.7);

const evContra = Planner.evidence([
  { title: 'Markets Rally After Decision', url: 'https://www.reuters.com/1', snippet: 'Stocks gains 10% in early trading.', source: 'news', publishedAt: Date.now() },
  { title: 'Markets Rally After Decision', url: 'https://www.ft.com/1', snippet: 'Markets falls sharply on the news.', source: 'news', publishedAt: Date.now() },
]);
check('contradiction detected within a cluster', evContra.contradictionCount >= 1);

// ── 7. Confidence levels ──
check('confidenceLevel high', Planner.confidenceLevel(0.9).color === 'green');
check('confidenceLevel medium', Planner.confidenceLevel(0.5).color === 'yellow');
check('confidenceLevel low', Planner.confidenceLevel(0.2).color === 'red');

// ── 8. Source overlay + limitations ──
const enabled = { wikipedia: true, web: true, hackernews: true, news: true, academic: false };
const ov = Planner.sourceOverlay(['academic', 'news', 'hackernews'], enabled);
check('sourceOverlay respects enabled sources', !ov.academic && ov.news === true && ov.hackernews === true);
check('sourceOverlay keeps safety net', ov.wikipedia === true && ov.web === true);

const lim = Planner.buildLimitations({ aspects: [{ id: 'a1', question: 'Q' }], origin: 'heuristic' }, [{ aspectId: 'a1', reason: 'thin' }], [{ aspect: 'a1', message: 'x' }], 0);
check('limitations lists gaps and errors', lim.length >= 3);

// ── 9. Async plan() with no AI available → heuristic fallback ──
Planner.plan('quantum computing advances', {}).then(p => {
  check('plan() falls back to heuristic plan (no AI in Node)', !!p && p.origin === 'heuristic' && Array.isArray(p.aspects) && p.aspects.length >= 2);
  check('plan() aspects normalized with queries', p.aspects.every(a => a.id && a.question && Array.isArray(a.queries) && a.queries.length));
  finish();
}).catch(() => finish());
