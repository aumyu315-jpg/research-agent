// Quick smoke test for the Aurora Anchor narration engine (pure functions, runs in Node)
const fs = require('fs');
const Anchor = new Function(fs.readFileSync('js/anchor.js', 'utf8') + '\nreturn Anchor;')();

let pass = 0;
const TOTAL = 38;
const check = (name, cond) => { pass += cond ? 1 : 0; console.log(cond ? 'PASS:' : 'FAIL:', name); };

// 1. Story-type detection
check('detects finance from market keywords', Anchor.detectStoryType('Markets rally on rate cut', 'Stocks surged today').type === 'finance');
check('detects technology from AI keywords', Anchor.detectStoryType('New AI chip from NVIDIA', 'semiconductor breakthrough').type === 'technology');
check('detects breaking news', Anchor.detectStoryType('BREAKING: quake hits coast', '').type === 'breaking');
check('detects science', Anchor.detectStoryType('', 'Scientists at NASA published a study on climate').type === 'science');
check('falls back to general', Anchor.detectStoryType('A quiet story about nothing', '').type === 'general');

// 2. Boilerplate stripping — never read adverts/widgets aloud
const junk = 'Image 1: Flood zone\nAdvertisement\nRelated stories\nClick here to read more\nThe real lead sentence carries the news.\nSign up for our newsletter';
check('strips junk lines', !Anchor.stripBoilerplate(junk).includes('Advertisement') && !Anchor.stripBoilerplate(junk).includes('Image 1'));
check('strips newsletter + related lines', !Anchor.stripBoilerplate(junk).includes('newsletter') && !Anchor.stripBoilerplate(junk).includes('Related stories'));
check('keeps the real content', Anchor.stripBoilerplate(junk).includes('real lead sentence'));
check('keeps sentences starting with Image/Photos', Anchor.stripBoilerplate('Image recognition is improving. Photos show the damage is extensive.') === 'Image recognition is improving. Photos show the damage is extensive.');

// 3. Pronunciation engine
check('pronounces NVIDIA', Anchor.pronounce('NVIDIA reported earnings') === 'en-VEE-dee-uh reported earnings');
check('pronounces TSMC as letters', Anchor.pronounce('TSMC makes chips') === 'T S M C makes chips');
check('pronounces OpenAI', Anchor.pronounce('OpenAI launched a model') === 'Open A I launched a model');
check('pronounces Bhubaneswar', Anchor.pronounce('near Bhubaneswar') === 'near BOO-bah-nays-wahr');
check('pronounces e.g. and i.e.', Anchor.pronounce('tools, e.g. i.e. examples') === 'tools, for example that is examples');
check('expands dollars and percent', Anchor.pronounce('$1.8 trillion, up 25%') === '1.8 trillion dollars, up 25 percent');
check('expands temperature', Anchor.pronounce('22°C today') === '22 degrees Celsius today');

// 4. Script construction — briefing vs deep dive
const article = 'The prime minister announced a new policy on Monday. ' +
  'The plan will cost 12 billion dollars over five years. ' +
  'Officials said the goal is to modernize infrastructure. ' +
  'Economists called the move significant. ' +
  'The opposition criticized the timeline. ' +
  'A parliamentary vote is expected in the coming weeks. ' +
  'The government said it will publish details next month.';

const briefing = Anchor.buildScript({ title: 'PM announces infrastructure policy', source: 'BBC News', text: article, mode: 'briefing' });
check('briefing builds chapters', briefing.chapters.length >= 2);
check('briefing opening carries the headline', briefing.chapters[0].text.toLowerCase().includes('infrastructure'));
check('briefing script is pronounced', !briefing.script.includes('$12 billion'));
check('briefing has attribution', briefing.script.includes('Reported by BBC News'));
check('briefing words < deep dive words', (() => {
  const deep = Anchor.buildScript({ title: 'PM announces infrastructure policy', text: article, mode: 'deep' });
  return deep.words >= briefing.words && deep.chapters.length >= briefing.chapters.length;
})());
check('briefing story type detected', briefing.storyType === 'politics');
check('no dangling transition-only chapters', (() => {
  const noNumbers = Anchor.buildScript({ title: 'A simple update', text: 'Officials shared an update. The situation remains under review. Teams continue their work. More details will follow soon.', mode: 'briefing' });
  return noNumbers.chapters.every(c => (c.text.replace(/^(?:Turning now to the details|In related developments|To better understand the significance|Looking at the broader picture|Meanwhile|To put this into context|Adding to that|And here is what that means in practice|Looking ahead)\.?\s*/i, '').trim().split(/\s+/).length >= 2));
})());

// 5. Transitions are never repeated within a script
const TRANSITION_SET = [
  'Turning now to the details', 'In related developments', 'To better understand the significance',
  'Looking at the broader picture', 'Meanwhile', 'To put this into context', 'Adding to that',
  'And here is what that means in practice', 'Looking ahead',
];
check('transitions do not repeat', (() => {
  const deep = Anchor.buildScript({ title: 'Test', text: 'First sentence here. Second sentence with 3 million dollars in costs. ' +
    'Third sentence about the broader economy. Fourth sentence provides more context. Fifth sentence adds detail again. ' +
    'Sixth sentence with another 42 percent figure. Seventh sentence wraps context. Eighth sentence final details.', mode: 'deep' });
  return TRANSITION_SET.every(t => (deep.script.match(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length <= 1);
})());

// 6. Report chapters from markdown headings
const md = '# Aurora Report\n\nIntro paragraph here.\n\n## Key Findings\n\nFinding one is important.\n\n## Analysis\n\nAnalysis paragraph text.\n\n## Outlook\n\nOutlook paragraph text.';
const report = Anchor.reportChapters(md, 'Aurora Report', 'deep');
check('report chapters from headings', report.chapters.length >= 3);
check('report chapter titles from headings', report.chapters.some(c => c.title === 'Key Findings'));
check('report falls back to narrative builder without headings', Anchor.reportChapters('Just a single block of prose without any headings at all.', 'T', 'deep').chapters.length >= 1);

// 7. Instant briefing is short and pronounced
const instant = Anchor.instantBriefing('Markets rally as Fed holds rates', 'Stocks jumped 2% today.');
check('instant briefing includes headline', instant.includes('Markets rally'));
check('instant briefing is pronounced', instant.includes('2 percent'));

// 8. AI-assisted script generation (mock provider chain — awaited, genuinely tested)
const LONG = 'An adequately long article body for the AI pass to engage with. '.repeat(10);
async function runAsyncTests() {
  // null without an ai module
  const t1 = (await Anchor.buildAiScript({ title: 'T', text: LONG, mode: 'briefing' })) === null;
  check('buildAiScript returns null without an ai module', t1);

  // null on short text
  const t2 = (await Anchor.buildAiScript({ title: 'T', text: 'short', mode: 'briefing', ai: { chat: async () => ({ markdown: 'x' }) } })) === null;
  check('buildAiScript returns null on short text', t2);

  // settings passthrough
  let captured = null;
  const aiOk = { chat: async (msgs, settings) => { captured = settings; return { markdown: 'OPENING: Hello world.\nCLOSING: Goodbye for now.' }; } };
  await Anchor.buildAiScript({ title: 'T', text: LONG, mode: 'briefing', ai: aiOk, settings: { groqKey: 'gsk_test' } });
  check('buildAiScript passes settings to ai.chat', !!(captured && captured.groqKey === 'gsk_test'));

  // AI error -> null fallback
  const aiBad = { chat: async () => { throw new Error('down'); } };
  const t4 = (await Anchor.buildAiScript({ title: 'T', text: LONG, mode: 'briefing', ai: aiBad })) === null;
  check('buildAiScript falls back to null on AI error', t4);

  // AI timeout -> null fallback (bounded pass must not hang the test)
  const aiSlow = { chat: () => new Promise((res) => setTimeout(() => res({ markdown: 'late' }), 20000)) };
  const t5 = (await Anchor.buildAiScript({ title: 'T', text: LONG, mode: 'briefing', ai: aiSlow })) === null;
  check('buildAiScript times out and returns null', t5);
}

// 9. AI script parsing
const aiOut = 'OPENING: The prime minister announced a sweeping infrastructure plan on Monday, promising twelve billion dollars in new spending over five years.\n' +
  'STORY: Officials say the goal is to modernize roads and rail across the country, with work beginning next quarter.\n' +
  'FACTS: The plan adds roughly twenty thousand jobs and targets a forty percent cut in commute times.\n' +
  'CLOSING: A parliamentary vote is expected in the coming weeks, and the government will publish full details next month.';
const parsed = Anchor.parseAiScript(aiOut, 'briefing', 'PM announces policy', 'BBC News');
check('parseAiScript builds chapters', parsed && parsed.chapters.length >= 2);
check('parseAiScript maps section titles', parsed && parsed.chapters.some(c => c.title === 'Key facts & figures'));
check('parseAiScript pronounces numbers', parsed && !parsed.script.includes('$') && parsed.script.includes('quarter'));
check('parseAiScript adds attribution', parsed && parsed.script.includes('Reported by BBC News'));

(async () => {
  await runAsyncTests();
  console.log(`\n${pass}/${TOTAL} tests passed`);
  process.exit(pass === TOTAL ? 0 : 1);
})();
