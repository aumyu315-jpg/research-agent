// Quick smoke test for the Aurora serverless content extractor (runs in Node)
const fs = require('fs');
const fnSrc = fs.readFileSync('netlify/functions/aurora.js', 'utf8');
// The function uses CommonJS `exports.*` — inject the module globals as params
const mod = { exports: {} };
const run = new Function('exports', 'module', fnSrc + '\nreturn { stripTags: exports._stripTags, decodeEntities: exports._decodeEntities, parseDdgHtml: exports._parseDdgHtml };');
const { stripTags, decodeEntities, parseDdgHtml } = run(mod.exports, mod);

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
