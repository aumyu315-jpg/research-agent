// Quick smoke test for the Aurora serverless content extractor (runs in Node)
const fs = require('fs');
const fnSrc = fs.readFileSync('netlify/functions/aurora.js', 'utf8');
// The function uses CommonJS `exports.*` — inject the module globals as params
const mod = { exports: {} };
const run = new Function('exports', 'module', 'require', fnSrc + '\nreturn { stripTags: exports._stripTags, decodeEntities: exports._decodeEntities, parseDdgHtml: exports._parseDdgHtml, parseRss: exports._parseRss, NEWS_FEEDS: exports._NEWS_FEEDS, NEWS_COUNTRIES: exports._NEWS_COUNTRIES, googleNewsUrl: exports._googleNewsUrl, ttsCacheKey: exports._ttsCacheKey, extractiveSummary: exports._extractiveSummary, buildSummaryPrompt: exports._buildSummaryPrompt, grabBalanced: exports._grabBalanced };');
const { stripTags, decodeEntities, parseDdgHtml, parseRss, NEWS_FEEDS, NEWS_COUNTRIES, googleNewsUrl, ttsCacheKey, extractiveSummary, buildSummaryPrompt, grabBalanced } = run(mod.exports, mod, require);

const tests = [
  {
    name: 'entity decoding',
    fn: () => decodeEntities('Tom &amp; Jerry &#8212; &quot;hi&quot; &#39;x&#39; &mdash; 5 &lt; 6'),
    expect: ["Tom & Jerry — \"hi\" 'x' — 5 < 6"],
  },
  {
    name: 'strips scripts & styles',
    fn: () => stripTags('<p>Hello</p><script>alert(1)</script><style>body{}</style><p>World</p>'),
    notExpect: ['alert', 'body{}'],
    expect: ['Hello', 'World'],
  },
  {
    name: 'prefers article over nav noise',
    fn: () => stripTags('<nav>Nav junk</nav><article><h1>Title</h1><p>Real content here.</p></article><footer>Foot</footer>'),
    expect: ['Title', 'Real content here.'],
    notExpect: ['Nav junk', 'Foot'],
  },
  {
    name: 'Wikipedia: prefers #mw-content-text, drops infobox & language sidebar',
    fn: () => stripTags(
      '<div id="mw-panel"><ul><li>Languages</li><li>Afrikaans</li></ul></div>' +
      '<div id="mw-content-text"><div class="mw-parser-output">' +
      '<table class="infobox"><tr><td>Born 1980</td></tr></table>' +
      '<p>Quantum computing is a field of study.</p>' +
      '<p>It uses qubits and superposition.</p>' +
      '</div></div>' +
      '<div id="footer">Copyright info</div>'),
    expect: ['Quantum computing is a field of study.', 'It uses qubits and superposition.'],
    notExpect: ['Born 1980', 'Languages', 'Afrikaans', 'Copyright'],
  },
  {
    name: 'balanced container grabber handles nested divs',
    fn: () => {
      const s = grabBalanced('<div id="mw-content-text"><div><p>deep</p></div><p>outer</p></div>tail', /<div[^>]*id=["']mw-content-text["'][^>]*>/i);
      return JSON.stringify([s.includes('deep'), s.includes('outer'), !s.includes('tail')]);
    },
    expect: ['[true,true,true]'],
  },
  {
    name: 'headings preserved as text',
    fn: () => stripTags('<h1>Big Heading</h1><p>Para one.</p><h2>Sub</h2>'),
    expect: ['Big Heading', 'Para one.', 'Sub'],
  },
  {
    name: 'lists become bullets',
    fn: () => stripTags('<ul><li>One</li><li>Two</li></ul>'),
    expect: ['One', 'Two'],
  },
  {
    name: 'no HTML tags leak',
    fn: () => stripTags('<p>a <b>b</b> <i>c</i></p>'),
    notExpect: ['<b>', '<i>', '<p>'],
  },
  {
    name: 'blank page returns short text',
    fn: () => stripTags('<html><head><title>x</title></head><body><p></p></body></html>'),
    // should collapse to empty/short
    notExpect: ['<'],
  },
  {
    name: 'DDG parser extracts title/url/snippet (snippet AFTER extras, like real 2026 HTML)',
    fn: () => JSON.stringify(parseDdgHtml(
      '<div class="result results_links results_links_deep web-result "><div class="links_main links_deep result__body"><h2 class="result__title"><a rel="nofollow" class="result__a" href="https://example.com/art">Quantum <b>Computing</b> Guide</a></h2><div class="result__extras"><div class="result__extras__url">example.com</div></div><a class="result__snippet" href="https://example.com/art">A deep dive into quantum bits.</a></div></div>' +
      '<div class="result results_links results_links_deep web-result "><div class="links_main links_deep result__body"><h2 class="result__title"><a rel="nofollow" class="result__a" href="https://second.org/x">Second result</a></h2><div class="result__extras"><div class="result__extras__url">second.org</div></div><a class="result__snippet" href="https://second.org/x">More text here.</a></div></div>')),
    expect: ['example.com/art', 'Quantum Computing Guide', 'A deep dive into quantum bits.', 'second.org', 'More text here.'],
  },
  {
    name: 'DDG parser decodes uddg redirect links',
    fn: () => JSON.stringify(parseDdgHtml(
      '<div class="result results_links results_links_deep web-result "><div class="links_main links_deep result__body"><h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.site%2Fpage%3Fa%3D1%26b%3D2&amp;rut=abc">Redirected link</a></h2><div class="result__extras"><div class="result__extras__url">real.site</div></div><a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.site%2Fpage%3Fa%3D1%26b%3D2&amp;rut=abc">Snippet here.</a></div></div>')),
    expect: ['real.site/page?a=1&b=2'],
    notExpect: ['duckduckgo.com/l'],
  },
  {
    name: 'DDG parser returns empty for junk html',
    fn: () => String(parseDdgHtml('<html><body>no results here</body></html>').length),
    expect: ['0'],
  },
  {
    name: 'RSS parser extracts title/link/description/date',
    fn: () => JSON.stringify(parseRss(
      '<?xml version="1.0"?><rss><channel><title>Test</title>' +
      '<item><title>Quantum chip breakthrough</title><link>https://example.com/q</link>' +
      '<description>Scientists &amp; engineers announced a &lt;b&gt;major&lt;/b&gt; advance.</description>' +
      '<pubDate>Wed, 30 Jul 2026 10:00:00 GMT</pubDate></item>' +
      '<item><title>Markets rally</title><link>https://example.com/m</link>' +
      '<description>Stocks closed higher.</description>' +
      '<pubDate>Thu, 31 Jul 2026 09:00:00 GMT</pubDate></item></channel></rss>')
      .map(it => ({ ...it, date: new Date(it.publishedAt).toISOString().slice(0, 10) }))),
    expect: ['Quantum chip breakthrough', 'example.com/q', 'major', '2026-07-30', 'Markets rally', '2026-07-31'],
    notExpect: ['&amp;', '<b>'],
  },
  {
    name: 'RSS parser handles Atom entry link and summary',
    fn: () => JSON.stringify(parseRss(
      '<?xml version="1.0"?><feed><entry><title>Atom story</title>' +
      '<link href="https://atom.example/story"/>' +
      '<summary>An Atom-formatted entry.</summary>' +
      '<updated>2026-07-29T08:00:00Z</updated></entry></feed>')
      .map(it => ({ ...it, date: new Date(it.publishedAt).toISOString().slice(0, 10) }))),
    expect: ['Atom story', 'atom.example/story', 'An Atom-formatted entry.', '2026-07-29'],
  },
  {
    name: 'RSS parser skips empty items and decodes entities',
    fn: () => JSON.stringify(parseRss(
      '<rss><channel>' +
      '<item><title>First &amp; Best</title><link>https://a.example/1</link><description>It&apos;s here</description></item>' +
      '<item><title></title><link></link></item>' +
      '</channel></rss>')),
    expect: ['First & Best', "It's here"],
    notExpect: ['&amp;', '&apos;', '&lt;'],
  },
  {
    name: 'RSS parser strips html inside CDATA/description',
    fn: () => JSON.stringify(parseRss(
      '<rss><channel>' +
      '<item><title>Clean</title><link>https://c.example/1</link>' +
      '<description><![CDATA[<p>Hello <b>world</b></p>]]></description></item>' +
      '</channel></rss>')),
    expect: ['Hello', 'world'],
    notExpect: ['<p>', '<b>', 'CDATA', ']]>'],
  },
  {
    name: 'RSS parser strips CDATA in titles too',
    fn: () => JSON.stringify(parseRss(
      '<rss><channel>' +
      '<item><title><![CDATA[CDATA &amp; Title]]></title><link>https://d.example/1</link><description>x</description></item>' +
      '</channel></rss>')),
    expect: ['CDATA & Title'],
    notExpect: ['CDATA[', ']]>'],
  },
  {
    name: 'RSS parser returns empty for junk xml',
    fn: () => String(parseRss('<html><body>no feed</body></html>').length),
    expect: ['0'],
  },
  {
    name: 'news feeds defined for all live categories',
    fn: () => JSON.stringify(Object.keys(NEWS_FEEDS).sort()),
    expect: ['top', 'world', 'tech', 'business', 'science', 'sports'],
  },
  {
    name: 'Google News parser extracts source outlet as meta',
    fn: () => JSON.stringify(parseRss(
      '<rss><channel>' +
      '<item><title>Headline one</title><link>https://news.google.com/rss/articles/abc</link>' +
      '<pubDate>Wed, 30 Jul 2026 10:00:00 GMT</pubDate>' +
      '<source url="https://www.cnn.com">CNN</source></item>' +
      '<item><title>Headline two</title><link>https://news.google.com/rss/articles/def</link>' +
      '<pubDate>Wed, 30 Jul 2026 09:00:00 GMT</pubDate>' +
      '<source url="https://www.bbc.com">BBC News</source></item>' +
      '</channel></rss>')),
    expect: ['Headline one', 'news.google.com', 'CNN', 'Headline two', 'BBC News'],
    notExpect: ['<source>'],
  },
  {
    name: 'countries defined for per-country news',
    fn: () => JSON.stringify(Object.keys(NEWS_COUNTRIES).sort()),
    expect: ['US', 'GB', 'IN', 'JP', 'BR', 'AU'],
  },
  {
    name: 'google news url builds country top feed',
    fn: () => googleNewsUrl('IN', null, 'top'),
    expect: ['news.google.com/rss', 'hl=en-IN', 'gl=IN', 'ceid=IN:en'],
  },
  {
    name: 'google news url builds country topic section',
    fn: () => googleNewsUrl('US', null, 'world'),
    expect: ['headlines/section/topic/WORLD', 'ceid=US:en'],
  },
  {
    name: 'google news url builds topic search query',
    fn: () => googleNewsUrl('US', 'quantum computing', null),
    expect: ['/rss/search?q=', 'quantum%20computing', 'hl=en-US'],
  },
  {
    name: 'tts cache key is deterministic and stable',
    fn: () => {
      const a = ttsCacheKey('voiceA', 'hello world', '1');
      const b = ttsCacheKey('voiceA', 'hello world', '1');
      const c = ttsCacheKey('voiceB', 'hello world', '1');
      const d = ttsCacheKey('voiceA', 'hello world', '1.5');
      return [a === b, a !== c, a !== d, a.length === 40].join(',');
    },
    expect: ['true,true,true,true'],
  },
  {
    name: 'extractive summary leads with first sentence and is bounded',
    fn: () => {
      const s = extractiveSummary('First sentence with the key fact. Second sentence adds detail. Third sentence continues the story. Fourth wraps it up with a date in 2026.');
      return JSON.stringify([s.includes('First sentence with the key fact'), s.includes('Fourth wraps it up'), s.length <= 3000]);
    },
    expect: ['[true,true,true]'],
  },
  {
    name: 'extractive summary handles tiny/empty text',
    fn: () => {
      const a = extractiveSummary('');
      const b = extractiveSummary('Just one short fragment without punctuation');
      return JSON.stringify([a === '', b.includes('fragment')]);
    },
    expect: ['[true,true]'],
  },
  {
    name: 'summary prompt asks for spoken-word prose, no markdown',
    fn: () => {
      const p = buildSummaryPrompt('Test Story', 'https://example.com/story', 'Article body text that is long enough to summarize.');
      return JSON.stringify([p.includes('NATURAL-SPEAKING'), p.includes('NO markdown'), p.includes('Test Story'), p.includes('Article body text')]);
    },
    expect: ['[true,true,true,true]'],
  },
];

let pass = 0;
for (const t of tests) {
  const out = t.fn();
  const okExpect = (t.expect || []).every(e => out.includes(e));
  const okNot = (t.notExpect || []).every(e => !out.includes(e));
  if (okExpect && okNot) { pass++; console.log('PASS:', t.name); }
  else {
    console.log('FAIL:', t.name);
    console.log('--- output ---\n' + JSON.stringify(out) + '\n--- end ---');
  }
}
console.log(`\n${pass}/${tests.length} tests passed`);
process.exit(pass === tests.length ? 0 : 1);
