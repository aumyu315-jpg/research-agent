// Quick smoke test for the Aurora markdown renderer (runs in Node)
const fs = require('fs');
// `const` inside eval doesn't leak to the outer scope, so use new Function + return
const Markdown = new Function(fs.readFileSync('js/markdown.js', 'utf8') + '\nreturn Markdown;')();

const tests = [
  {
    name: 'headings + bold + italic + link',
    input: '## Executive Summary\n\nThis is **bold** and *italic* with a [link](https://example.com).',
    expect: ['<h2>Executive Summary</h2>', '<strong>bold</strong>', '<em>italic</em>', '<a href="https://example.com"'],
  },
  {
    name: 'unordered list',
    input: '- Point one\n- Point two\n- Point three',
    expect: ['<ul>', '<li>Point one</li>', '<li>Point three</li>', '</ul>'],
  },
  {
    name: 'ordered list',
    input: '1. First\n2. Second',
    expect: ['<ol>', '<li>First</li>', '<li>Second</li>', '</ol>'],
  },
  {
    name: 'blockquote',
    input: '> A quoted insight\n> spanning two lines',
    expect: ['<blockquote>', 'A quoted insight'],
  },
  {
    name: 'table with separator',
    input: '| Col A | Col B |\n| --- | --- |\n| x | y |\n| p | q |',
    expect: ['<table>', '<th>Col A</th>', '<td>y</td>', '<td>q</td>', '</table>'],
  },
  {
    name: 'fenced code does not leak',
    input: 'Before\n```js\nconst x = 1;\nconst y = 2;\n```\nAfter',
    expect: ['<pre><code class="lang-js">', 'const x = 1;', 'After</p>'],
    notExpect: ['<p>const x = 1;</p>'], // the code must NOT be re-rendered as a paragraph
  },
  {
    name: 'XSS escaping',
    input: '## <script>alert(1)</script>\n\n`<img src=x onerror=alert(2)>`',
    expect: ['&lt;script&gt;', '&lt;img src=x onerror=alert(2)&gt;'],
    notExpect: ['<script>alert'],
  },
  {
    name: 'horizontal rule',
    input: 'One\n\n---\n\nTwo',
    expect: ['<hr/>'],
  },
];

let pass = 0;
for (const t of tests) {
  const html = Markdown.render(t.input);
  const okExpect = (t.expect || []).every(e => html.includes(e));
  const okNot = (t.notExpect || []).every(e => !html.includes(e));
  if (okExpect && okNot) { pass++; console.log('PASS:', t.name); }
  else {
    console.log('FAIL:', t.name);
    console.log('--- html ---\n' + html + '\n--- end ---');
  }
}
console.log(`\n${pass}/${tests.length} tests passed`);
process.exit(pass === tests.length ? 0 : 1);
