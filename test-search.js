// Quick smoke test for the Aurora query-type classifier (runs in Node)
const fs = require('fs');
const Search = new Function(fs.readFileSync('js/search.js', 'utf8') + '\nreturn Search;')();

let pass = 0;
const TOTAL = 20;
const check = (name, cond) => { pass += cond ? 1 : 0; console.log(cond ? 'PASS:' : 'FAIL:', name); };

// 1. Type detection
check('detects weather', Search.detectType('weather forecast in London tomorrow') === 'weather');
check('detects temperature query', Search.detectType('temperature in Tokyo today') === 'weather');
check('detects markets (bitcoin)', Search.detectType('bitcoin price today') === 'markets');
check('detects markets (stock)', Search.detectType('Tesla stock price') === 'markets');
check('detects news', Search.detectType('breaking news AI regulation') === 'news');
check('detects academic', Search.detectType('research paper on quantum error correction') === 'academic');
check('detects code', Search.detectType('github react library for charts') === 'code');
check('detects books', Search.detectType('best book on investing') === 'books');
check('detects qa', Search.detectType('how do I fix a memory leak') === 'qa');
check('returns null for general query', Search.detectType('history of the roman empire') === null);
check('returns null for short input', Search.detectType('hi') === null);

// 2. Routing
const enabled = { wikipedia: true, hackernews: true, web: true, academic: true, news: false, books: true, qa: true, code: true, markets: true, weather: true };

const wx = Search.routeSources('weather', enabled);
check('weather routes include weather source', wx.sources.includes('weather'));
check('weather boosts weather x2', wx.boost.weather === 2);
check('weather keeps web+wikipedia', wx.sources.includes('web') && wx.sources.includes('wikipedia'));
check('weather skips irrelevant sources', !wx.sources.includes('code') && !wx.sources.includes('markets') && wx.boost.code === 0 && wx.boost.markets === 0);

const mk = Search.routeSources('markets', enabled);
check('markets boosts markets x2', mk.boost.markets === 2);
// news is disabled in this fixture, so it should NOT be routed; web is kept
check('markets keeps web and skips disabled news', mk.sources.includes('web') && !mk.sources.includes('news'));

const mk2 = Search.routeSources('markets', { ...enabled, news: true });
check('markets keeps news when enabled', mk2.sources.includes('news'));

const noType = Search.routeSources(null, enabled);
check('no type runs all enabled sources', noType.sources.length === Object.keys(enabled).filter(k => enabled[k]).length);

const gen = Search.routeSources(null, { wikipedia: true, web: true, code: false });
check('no type respects disabled sources', gen.sources.includes('wikipedia') && !gen.sources.includes('code'));

console.log(`\n${pass}/${TOTAL} tests passed`);
process.exit(pass === TOTAL ? 0 : 1);
