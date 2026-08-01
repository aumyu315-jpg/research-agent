// Quick smoke test for the Aurora TTS engine (pure functions, runs in Node)
const fs = require('fs');
const TTS = new Function(fs.readFileSync('js/tts.js', 'utf8') + '\nreturn TTS;')();

let pass = 0;
const TOTAL = 17;
const check = (name, cond) => { pass += cond ? 1 : 0; console.log(cond ? 'PASS:' : 'FAIL:', name); };

// 1. Text sanitization
check('strips markdown links to label', TTS.cleanText('[OpenAI](https://openai.com)') === 'OpenAI');
check('strips inline code backticks', TTS.cleanText('run `npm install`') === 'run npm install');
check('strips bold/italic/highlight', TTS.cleanText('**key** *fact* ==2026==') === 'key fact 2026');
check('strips headers and bullets', TTS.cleanText('## Title\n- one\n- two').includes('Title') && TTS.cleanText('## Title\n- one\n- two').includes('one two'));
check('strips URLs and citations', TTS.cleanText('see https://x.com [3] now') === 'see now');
check('converts table pipes to commas', TTS.cleanText('|A|B|') === 'A, B');
check('cleans leading/trailing separators', TTS.cleanText('| A | B |') === 'A, B');

// 2. Chunking
const long = 'First sentence here. Second sentence there. Third sentence everywhere. ' +
  'Fourth sentence is a bit longer to test boundaries. Fifth wraps up the paragraph.';
const chunks = TTS.chunkText(long, 60);
check('long text splits into multiple chunks', chunks.length > 1);
check('no chunk exceeds the max length', chunks.every(c => c.length <= 60));
check('chunks keep full text content', chunks.join(' ').replace(/\s+/g, ' ').includes('First sentence here'));
check('short text stays in one chunk', TTS.chunkText('Just a short phrase.', 60).length === 1);
check('empty text returns no chunks', TTS.chunkText('   ').length === 0);
check('chunks end on sentence punctuation', chunks.every(c => /[.!?]$/.test(c.trim())));

// 3. Narrator config (free neural narrator)
check('narrator disabled by default', TTS.narratorEnabled() === false);
check('narrator disabled without voice', (() => { TTS.setNarrator({ voice: '' }); return TTS.narratorEnabled() === false && TTS.narratorConfig().voice === ''; })());
check('setNarrator stores voice', (() => { TTS.setNarrator({ voice: 'en-US-AriaNeural' }); const c = TTS.narratorConfig(); return c.voice === 'en-US-AriaNeural'; })());
check('neural chunking uses larger max and keeps content', (() => {
  const big = 'Sentence one here. Sentence two over there. Sentence three is a little longer to push past the 200-char default boundary. ' +
    'Sentence four continues on. Sentence five wraps up this chunk nicely and keeps everything intact.';
  const c = TTS.chunkText(big, 500);
  return c.length === 1 && c[0].includes('Sentence one here') && c[0].includes('wraps up');
})());

console.log(`\n${pass}/${TOTAL} tests passed`);
process.exit(pass === TOTAL ? 0 : 1);
