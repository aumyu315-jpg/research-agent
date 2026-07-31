/* ─────────────────────────────────────────────
   Aurora — lightweight Markdown renderer
   (no dependencies, safe: escapes HTML first)
   ───────────────────────────────────────────── */
const Markdown = (() => {
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // inline: code, bold, italic, strikethrough, links
  function inline(text) {
    return esc(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/_([^_]+)_/g, '<em>$1</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }

  function renderTable(rows) {
    // rows[0] = header, rest = body (separator already skipped by caller)
    if (!rows.length) return '';
    const split = r => r.split('|').map(c => c.trim()).filter(Boolean);
    const head = split(rows[0]);
    let h = '<table><thead><tr>' + head.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
    for (let k = 1; k < rows.length; k++) {
      const cells = split(rows[k]);
      if (!cells.length) continue;
      h += '<tr>' + cells.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>';
    }
    return h + '</tbody></table>';
  }

  function render(src) {
    if (!src) return '';
    const lines = String(src).replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const raw = lines[i];
      const line = raw.trimEnd();

      // blank
      if (!line.trim()) { i++; continue; }

      // fenced code — consume opening fence, content, closing fence
      const fence = line.trim().match(/^```(\w*)/);
      if (fence) {
        const lang = fence[1];
        const code = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i].trim())) {
          code.push(lines[i]);
          i++;
        }
        i++; // skip closing fence (or EOF)
        out.push(`<pre><code${lang ? ` class="lang-${esc(lang)}"` : ''}>${esc(code.join('\n'))}</code></pre>`);
        continue;
      }

      // headings
      const h = line.match(/^(#{1,4})\s+(.*)/);
      if (h) {
        out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
        i++;
        continue;
      }

      // horizontal rule
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
        out.push('<hr/>');
        i++;
        continue;
      }

      // blockquote — consume all consecutive quote lines, recurse
      if (/^>\s?/.test(line)) {
        const q = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          q.push(lines[i].replace(/^>\s?/, ''));
          i++;
        }
        out.push(`<blockquote>${render(q.join('\n'))}</blockquote>`);
        continue;
      }

      // lists — consume consecutive list items (ul/ol mixed into one block)
      const ul = line.match(/^\s*[-*+]\s+(.*)/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
      if (ul || ol) {
        const items = [];
        let kind = null;
        while (i < lines.length) {
          const m = lines[i].match(/^\s*[-*+]\s+(.*)/) || lines[i].match(/^\s*\d+[.)]\s+(.*)/);
          if (!m) break;
          items.push(m[1].trim());
          kind = kind || (lines[i].match(/^\s*\d+[.)]\s+/) ? 'ol' : 'ul');
          i++;
        }
        const tag = kind === 'ol' ? 'ol' : 'ul';
        out.push(`<${tag}>${items.map(it => `<li>${inline(it)}</li>`).join('')}</${tag}>`);
        continue;
      }

      // table or pipe-prefixed line — header + separator + body rows
      if (/^\|/.test(line.trim())) {
        const rows = [line.trim()];
        let j = i + 1;
        let isTable = false;
        if (j < lines.length && /^\|[\s:|-]+\|$/.test(lines[j].trim())) {
          isTable = true;
          j++; // skip separator
          while (j < lines.length && /^\|.*\|$/.test(lines[j].trim())) {
            rows.push(lines[j].trim());
            j++;
          }
        }
        if (isTable) {
          out.push(renderTable(rows));
          i = j;
          continue;
        }
        // lone/malformed pipe line that isn't a table — render as a paragraph
        out.push(`<p>${inline(line.trim())}</p>`);
        i++;
        continue;
      }

      // paragraph — accumulate consecutive plain lines
      const para = [];
      while (i < lines.length) {
        const t = lines[i].trimStart();
        if (!t.trim() || /^(#{1,4}\s|```|>\s?|[-*+]\s|\d+[.)]\s|\|)/.test(t)) break;
        para.push(lines[i].trim());
        i++;
      }
      out.push(`<p>${inline(para.join(' '))}</p>`);
    }
    return out.join('\n');
  }

  return { render, inline };
})();
