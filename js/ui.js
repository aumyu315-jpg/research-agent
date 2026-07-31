/* ─────────────────────────────────────────────
   Aurora — UI helpers
   ───────────────────────────────────────────── */
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const UI = {
  el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  },

  toast(message, type = 'ok', ms = 3200) {
    const wrap = $('#toastWrap');
    const icons = { ok: 'i-check', err: 'i-x', info: 'i-spark' };
    const t = this.el('div', `toast ${type}`);
    t.innerHTML = `<svg class="ic" aria-hidden="true"><use href="#${icons[type] || 'i-info'}"/></svg><span>${message}</span>`;
    wrap.appendChild(t);
    setTimeout(() => {
      t.classList.add('out');
      setTimeout(() => t.remove(), 320);
    }, ms);
  },

  timeAgo(ts) {
    if (!ts) return '';
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d}d ago`;
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  },

  fmtDate(ts) {
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) +
           ' · ' + new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  },

  debounce(fn, ms = 250) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  },

  async copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
  },

  esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  },

  domain(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
  },

  skeleton(n = 6) {
    return Array.from({ length: n }, () => `
      <div class="result-card is-skeleton">
        <div class="rc-top"><div class="sk" style="width:92px;height:22px"></div><div class="sk" style="width:52px;height:16px;margin-left:auto"></div></div>
        <div class="sk" style="width:92%;height:20px"></div>
        <div class="sk" style="width:100%;height:13px"></div>
        <div class="sk" style="width:70%;height:13px"></div>
        <div class="sk" style="width:38%;height:13px"></div>
      </div>`).join('');
  },

  download(filename, text, mime = 'text/markdown') {
    const blob = new Blob([text], { type: mime + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  },

  // Promise-based confirm dialog (asks before downloads/exports)
  confirm(title, message, okLabel = 'Download', cancelLabel = 'Cancel') {
    return new Promise(resolve => {
      const backdrop = this.el('div', 'modal-backdrop confirm-modal');
      backdrop.innerHTML = `
        <div class="modal confirm" role="dialog" aria-modal="true" aria-labelledby="confirmTitle">
          <div class="modal-head">
            <h3 id="confirmTitle">${this.esc(title)}</h3>
            <button class="icon-btn" data-confirm-cancel aria-label="Close"><svg class="ic" aria-hidden="true"><use href="#i-x"/></svg></button>
          </div>
          <div class="modal-body confirm-body">
            <div class="confirm-orb"><svg class="ic" aria-hidden="true"><use href="#i-download"/></svg></div>
            <p>${message}</p>
            <div class="confirm-actions">
              <button class="btn btn-ghost" data-confirm-cancel>${this.esc(cancelLabel)}</button>
              <button class="btn btn-primary" data-confirm-ok>${this.esc(okLabel)}</button>
            </div>
          </div>
        </div>`;
      document.body.appendChild(backdrop);
      const done = v => { backdrop.remove(); resolve(v); };
      backdrop.querySelectorAll('[data-confirm-cancel]').forEach(b => b.addEventListener('click', () => done(false)));
      backdrop.querySelector('[data-confirm-ok]').addEventListener('click', () => done(true));
      backdrop.addEventListener('click', e => { if (e.target === backdrop) done(false); });
      const onKey = e => { if (e.key === 'Escape') { done(false); document.removeEventListener('keydown', onKey); } };
      document.addEventListener('keydown', onKey);
    });
  },

  setLoading(btn, loading, label) {
    if (!btn) return;
    if (loading) {
      btn.dataset.prevHtml = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = `<span class="orbit-core" style="position:relative;inset:auto;width:18px;height:18px;border-radius:50%"><svg class="ic" style="width:11px;height:11px" aria-hidden="true"><use href="#i-spark"/></svg></span><span>${label || 'Working…'}</span>`;
    } else {
      btn.disabled = false;
      if (btn.dataset.prevHtml) btn.innerHTML = btn.dataset.prevHtml;
    }
  },

  typewriter(el, text, speed = 26, loop = false) {
    let i = 0;
    el.textContent = '';
    const tick = () => {
      if (i < text.length) {
        el.textContent += text[i++];
        setTimeout(tick, speed);
      }
    };
    tick();
  },
};
