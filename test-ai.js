// Quick smoke test for the Aurora AI layer (runs in Node)
const fs = require('fs');
const AI = new Function(fs.readFileSync('js/ai.js', 'utf8') + '\nreturn AI;')();

const fakeResults = [
  { title: 'Quantum computing overview', url: 'https://en.wikipedia.org/wiki/Quantum_computing', snippet: 'Uses qubits and superposition.', source: 'wikipedia' },
  { title: 'HN discussion', url: 'https://news.ycombinator.com/item?id=1', snippet: 'Discussion about quantum supremacy.', source: 'hackernews' },
  { title: 'Paper on error correction', url: 'https://doi.org/10.1', snippet: 'New error correction codes.', source: 'academic' },
  { title: 'A book on quantum', url: 'https://openlibrary.org/works/OL1', snippet: 'by Jane Doe, first published 2020', source: 'books' },
  { title: 'SO question', url: 'https://stackoverflow.com/q/1', snippet: 'Score 42, 5 answers', source: 'qa' },
  { title: 'GitHub repo', url: 'https://github.com/foo/bar', snippet: 'A quantum simulator.', source: 'code' },
  { title: 'Bitcoin price', url: 'https://www.coingecko.com/en/coins/bitcoin', snippet: 'rank #1, live price $64000', source: 'markets' },
  { title: 'London weather', url: 'https://open-meteo.com', snippet: 'Rain, 12C', source: 'weather' },
];

let pass = 0;
const TOTAL = 26;
const check = (name, cond) => { pass += cond ? 1 : 0; console.log(cond ? 'PASS:' : 'FAIL:', name); };

// 1. Prompt builder structure & professionalism
const prompt = AI.buildPrompt('quantum computing', fakeResults);
check('system prompt has Executive Summary', prompt.system.includes('## Executive Summary'));
check('system prompt has Data Snapshot', prompt.system.includes('## Data Snapshot'));
check('system prompt has Perspectives & Criticisms', prompt.system.includes('## Perspectives & Criticisms'));
check('system prompt has Outlook', prompt.system.includes('## Outlook'));
check('system prompt bans invented data', /never invent/i.test(prompt.system));
check('system prompt requires citations', /cite sources inline/i.test(prompt.system));
check('system prompt targets a comprehensive report length', /1200–2000 words/.test(prompt.system));
check('user prompt includes today date', /Today's date: \d{4}-\d{2}-\d{2}/.test(prompt.user));
check('user prompt includes topic', prompt.user.includes('quantum computing'));
check('user prompt includes all source types', ['wikipedia', 'hackernews', 'academic', 'books', 'qa', 'code', 'markets', 'weather'].every(s => prompt.user.includes(s)));
check('user prompt includes [1] markers', prompt.user.includes('[1]'));

// 2. Local synthesis covers new sources & citations valid
const local = AI.localSynthesis('quantum computing', fakeResults);
check('local synthesis has all sections', ['## Executive Summary', '## Key Findings', '## Detailed Analysis', '## Sources'].every(s => local.markdown.includes(s)));
check('local synthesis provider is local', local.provider === 'local');
check('local synthesis maps books label', local.markdown.includes('Books'));
check('local synthesis maps markets label', local.markdown.includes('Market data'));
check('no zero citations in local synthesis', !/\[0\]/.test(local.markdown));
check('local synthesis lists sources', fakeResults.slice(0, 8).every(r => local.markdown.includes(r.url)));

// 3. Fallback chain ordering (pollinations default, keys preferred)
const attempts = [];
const settings = { provider: 'pollinations', geminiKey: '', groqKey: '', openrouterKey: '', geminiModel: '', groqModel: '', openrouterModel: '' };
// simulate by checking the built chain logic directly is not exported, so verify buildPrompt/localSynthesis edge cases instead
check('local synthesis handles empty results', AI.localSynthesis('x', []).markdown.includes('## Executive Summary'));

// 4. Chat prompt builder & local chat fallback
const chatMessages = [
  { role: 'user', content: 'What is the latest on quantum computing?' },
  { role: 'assistant', content: 'Here is a quick summary...' },
  { role: 'user', content: 'Tell me more about error correction' },
];
const chatPrompt = AI.buildChatPrompt(chatMessages);
check('chat prompt has a system message', chatPrompt.system && chatPrompt.system.length > 80);
check('chat prompt includes user content', chatPrompt.user.includes('What is the latest on quantum computing?'));
check('chat prompt includes assistant history', chatPrompt.user.includes('Here is a quick summary'));
check('chat prompt includes latest question', chatPrompt.user.includes('Tell me more about error correction'));
check('chat prompt encourages highlights', chatPrompt.system.includes('=='));
const localChat = AI.localChatReply([{ role: 'user', content: 'Is the sky blue?' }]);
check('local chat reply always succeeds', localChat.markdown.length > 20);
check('local chat reply quotes the question', localChat.markdown.includes('Is the sky blue?'));
check('local chat reply marks offline mode', localChat.markdown.toLowerCase().includes('offline'));

console.log(`\n${pass}/${TOTAL} tests passed`);
process.exit(pass === TOTAL ? 0 : 1);
