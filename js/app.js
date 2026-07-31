/* ─────────────────────────────────────────────
   Aurora — main application controller
   ───────────────────────────────────────────── */
(function () {
  'use strict';

  const DEFAULT_SETTINGS = {
    provider: 'pollinations',      // 'pollinations' | 'gemini' | 'groq' | 'openrouter'
    geminiKey: '',
    geminiModel: 'gemini-2.5-flash',
    groqKey: '',
    groqModel: 'llama-3.3-70b-versatile',
    openrouterKey: '',
    openrouterModel: 'meta-llama/llama-3.3-70b-instruct:free',
    newsKey: '',
    perSource: 8,
    contentReader: true,           // fetch full article text via serverless backend
    autoRoute: true,               // detect query type & prioritize matching sources
    sources: {
      wikipedia: true, hackernews: true, web: true, academic: true, news: false,
      books: true, qa: true, code: true, markets: true, weather: true,
    },
  };

  const TRENDING = [
    'Quantum computing breakthroughs 2026',
    'AI in healthcare',
    'Climate change latest science',
    'Electric vehicles market',
    'Space exploration missions',
    'Global chip shortage',
    'Renewable energy storage',
    'Cybersecurity threats',
  ];

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    lastQuery: '',
    results: [],
    resultsBySource: {},
    reportMarkdown: '',
    reportTitle: '',
    reportSources: [],
    reportSavedId: null,
    isGenerating: false,
    online: navigator.onLine !== false,
  };

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];

  // ═══════════ INIT ═══════════
  function init() {
    loadSettings();
    applySettingsToUI();
    renderTrending();
    bindEvents();
    updateConnection();
    window.addEventListener('online', updateConnection);
    window.addEventListener('offline', updateConnection);
    registerSW();
    refreshLibraryCount();
    if (location.hash.startsWith('#report=')) openReportFromHash(location.hash.slice(8));
  }

  function loadSettings() {
    const saved = Storage.getSettings();
    state.settings = { ...DEFAULT_SETTINGS, ...saved, sources: { ...DEFAULT_SETTINGS.sources, ...(saved.sources || {}) } };
  }

  function saveSettings() {
    Storage.saveSettings(state.settings);
  }

  function applySettingsToUI() {
    $('#providerCards').querySelector(`[data-provider="${state.settings.provider}"]`)?.classList.add('selected');
    const radios = $$('#providerCards input');
    for (const r of radios) r.checked = r.value === state.settings.provider;
    $('#geminiKey').value = state.settings.geminiKey || '';
    $('#geminiModel').value = state.settings.geminiModel || 'gemini-2.5-flash';
    $('#groqKey').value = state.settings.groqKey || '';
    $('#groqModel').value = state.settings.groqModel || 'llama-3.3-70b-versatile';
    $('#openrouterKey').value = state.settings.openrouterKey || '';
    $('#openrouterModel').value = state.settings.openrouterModel || 'meta-llama/llama-3.3-70b-instruct:free';
    $('#newsKey').value = state.settings.newsKey || '';
    $('#perSource').value = state.settings.perSource;
    $('#perSourceVal').textContent = state.settings.perSource;
    $('#srcWikipedia').checked = !!state.settings.sources.wikipedia;
    $('#srcHackerNews').checked = !!state.settings.sources.hackernews;
    $('#srcWeb').checked = !!state.settings.sources.web;
    $('#srcAcademic').checked = !!state.settings.sources.academic;
    $('#srcNews').checked = !!state.settings.sources.news;
    $('#srcBooks').checked = !!state.settings.sources.books;
    $('#srcQa').checked = !!state.settings.sources.qa;
    $('#srcCode').checked = !!state.settings.sources.code;
    $('#srcMarkets').checked = !!state.settings.sources.markets;
    $('#srcWeather').checked = !!state.settings.sources.weather;
    $('#contentReader').checked = !!state.settings.contentReader;
    $('#autoRoute').checked = !!state.settings.autoRoute;
    $('#geminiGroup').hidden = state.settings.provider !== 'gemini';
    $('#groqGroup').hidden = state.settings.provider !== 'groq';
    $('#openrouterGroup').hidden = state.settings.provider !== 'openrouter';
    $('.news-key-row').hidden = !state.settings.sources.news;
    refreshBackendStatus();
  }

  // ═══════════ EVENTS ═══════════
  function bindEvents() {
    // nav
    $('#brandBtn').addEventListener('click', () => showView('home'));
    $$('.topnav-link').forEach(a => a.addEventListener('click', e => {
      e.preventDefault();
      showView(a.dataset.view);
    }));
    $$('[data-goto]').forEach(b => b.addEventListener('click', () => showView(b.dataset.goto)));

    // search
    $('#searchForm').addEventListener('submit', e => { e.preventDefault(); doSearch($('#searchInput').value); });
    // Note: #searchGo is type=submit inside the form — no separate click handler needed (avoids double-firing).
    $('#searchInput').addEventListener('input', UI.debounce(handleSuggest, 200));
    $('#searchInput').addEventListener('keydown', e => {
      if (e.key === 'Escape') $('#suggestions').hidden = true;
      if (e.key === 'ArrowDown' && !$('#suggestions').hidden) {
        e.preventDefault();
        const items = $$('.sug-item');
        if (!items.length) return;
        const cur = items.findIndex(i => i.classList.contains('hl'));
        items.forEach(i => i.classList.remove('hl'));
        items[(cur + 1) % items.length].classList.add('hl');
      }
    });

    // global: "/" focuses search (only when the settings modal is closed)
    document.addEventListener('keydown', e => {
      if (e.key === '/' && document.activeElement !== $('#searchInput') && $('#settingsModal').hidden) {
        e.preventDefault();
        $('#searchInput').focus();
      }
      if (e.key === 'Escape' && !$('#settingsModal').hidden) closeSettings();
    });

    // settings
    $('#settingsBtn').addEventListener('click', openSettings);
    $$('#settingsModal [data-close-modal]').forEach(b => b.addEventListener('click', closeSettings));
    $('#settingsModal').addEventListener('click', e => { if (e.target === $('#settingsModal')) closeSettings(); });
    $('#providerCards').addEventListener('change', e => {
      if (e.target.name === 'provider') {
        state.settings.provider = e.target.value;
        $('#geminiGroup').hidden = state.settings.provider !== 'gemini';
        $('#groqGroup').hidden = state.settings.provider !== 'groq';
        $('#openrouterGroup').hidden = state.settings.provider !== 'openrouter';
        saveSettings();
      }
    });
    $('#geminiKey').addEventListener('change', e => { state.settings.geminiKey = e.target.value.trim(); saveSettings(); });
    $('#geminiModel').addEventListener('change', e => { state.settings.geminiModel = e.target.value; saveSettings(); });
    $('#groqKey').addEventListener('change', e => { state.settings.groqKey = e.target.value.trim(); saveSettings(); });
    $('#groqModel').addEventListener('change', e => { state.settings.groqModel = e.target.value; saveSettings(); });
    $('#openrouterKey').addEventListener('change', e => { state.settings.openrouterKey = e.target.value.trim(); saveSettings(); });
    $('#openrouterModel').addEventListener('change', e => { state.settings.openrouterModel = e.target.value; saveSettings(); });
    $('#newsKey').addEventListener('change', e => { state.settings.newsKey = e.target.value.trim(); saveSettings(); });
    $('#perSource').addEventListener('input', e => {
      $('#perSourceVal').textContent = e.target.value;
      state.settings.perSource = Number(e.target.value);
      saveSettings();
    });
    [['#srcWikipedia', 'wikipedia'], ['#srcHackerNews', 'hackernews'], ['#srcWeb', 'web'],
     ['#srcAcademic', 'academic'], ['#srcNews', 'news'], ['#srcBooks', 'books'],
     ['#srcQa', 'qa'], ['#srcCode', 'code'], ['#srcMarkets', 'markets'], ['#srcWeather', 'weather']].forEach(([sel, key]) => {
      $(sel).addEventListener('change', e => {
        state.settings.sources[key] = e.target.checked;
        $('.news-key-row').hidden = !state.settings.sources.news;
        saveSettings();
      });
    });
    $('#contentReader').addEventListener('change', e => {
      state.settings.contentReader = e.target.checked;
      saveSettings();
      refreshBackendStatus();
    });
    $('#autoRoute').addEventListener('change', e => {
      state.settings.autoRoute = e.target.checked;
      saveSettings();
    });
    $('#clearLibBtn').addEventListener('click', clearLibrary);

    // results & report
    $('#generateBtn').addEventListener('click', generateReport);
    $('#regenerateBtn').addEventListener('click', generateReport);
    $('#reportBackBtn').addEventListener('click', () => showView('results'));
    $('#copyReportBtn').addEventListener('click', copyReport);
    $('#downloadReportBtn').addEventListener('click', downloadReport);
    $('#exportLibBtn').addEventListener('click', exportLibrary);
    $('#librarySearch').addEventListener('input', UI.debounce(renderLibrary, 150));

    // trending chips (event delegation)
    $('#trendingChips').addEventListener('click', e => {
      const chip = e.target.closest('.chip');
      if (chip) {
        $('#searchInput').value = chip.dataset.q;
        doSearch(chip.dataset.q);
      }
    });
  }

  // ═══════════ VIEW ROUTING ═══════════
  function showView(name) {
    $$('[data-view-panel]').forEach(v => v.hidden = v.id !== `view-${name}`);
    $$('.topnav-link').forEach(a => a.classList.toggle('active', a.dataset.view === name));
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (name === 'library') {
      refreshLibraryCount();
      renderLibrary();
    }
  }

  // ═══════════ SEARCH ═══════════
  async function doSearch(query) {
    query = (query || '').trim();
    if (!query) { UI.toast('Type something to search', 'info'); return; }

    state.lastQuery = query;
    state.results = [];
    $('#searchInput').value = query;
    $('#suggestions').hidden = true;
    $('#resultsQuery').textContent = query;
    $('#resultsMeta').textContent = 'Searching…';
    $('#resultsEmpty').hidden = true;
    $('#generateBtn').disabled = true;
    showView('results');

    const grid = $('#resultsGrid');
    grid.innerHTML = UI.skeleton(6);
    $('#resultsLoading').hidden = false;

    const started = Date.now();
    const res = await Search.run(query, state.settings);
    const elapsed = Math.max(0, 900 - (Date.now() - started));
    await new Promise(r => setTimeout(r, elapsed)); // keep the loader feeling intentional

    $('#resultsLoading').hidden = true;
    state.results = res.results;
    state.resultsBySource = groupBySource(res.results);
    state.detected = res.detected || null;

    const total = res.results.length;
    const okSources = res.sources.filter(s => !res.errors.find(e => e.source === s));
    $('#resultsMeta').textContent =
      `${total} result${total === 1 ? '' : 's'} from ${okSources.length} source${okSources.length === 1 ? '' : 's'}` +
      (res.errors.length ? ` · ${res.errors.length} unavailable` : '');
    $('#detectedBadge').hidden = !state.detected;
    if (state.detected) {
      const dm = Search.TYPE_META && Search.TYPE_META[state.detected];
      $('#detectedBadge').innerHTML =
        `<svg class="ic" aria-hidden="true"><use href="#i-spark"/></svg>` +
        `Auto-detected: <b>${dm ? dm.label : state.detected}</b>` +
        ` — prioritized matching sources`;
    }

    if (res.errors.length) {
      const names = res.errors.map(e => e.source).join(', ');
      UI.toast(`Some sources were unreachable: ${names}.`, 'info', 4200);
    }

    renderSourceTabs();
    renderResults('all');
    refreshLibraryCount();

    if (total === 0) {
      $('#resultsEmpty').hidden = false;
      $('#resultsEmptyMsg').textContent = `Nothing found for "${query}". Try different keywords or enable more sources in Settings.`;
    } else {
      $('#generateBtn').disabled = false;
    }
  }

  function groupBySource(results) {
    const g = {};
    for (const r of results) (g[r.source] = g[r.source] || []).push(r);
    return g;
  }

  function renderSourceTabs() {
    const tabs = $('#sourceTabs');
    const meta = Search.sourceMeta;
    const all = [...state.results];
    const counts = { all: all.length };
    for (const [k, v] of Object.entries(state.resultsBySource)) counts[k] = v.length;

    const keys = ['all', ...Object.keys(state.resultsBySource)];
    tabs.innerHTML = keys.map(k => `
      <button class="src-tab ${k === 'all' ? 'active' : ''}" data-source="${k}" role="tab">
        ${k !== 'all' ? `<svg class="ic" aria-hidden="true"><use href="#${meta[k].icon}"/></svg>` : ''}
        ${k === 'all' ? 'All' : meta[k].label}
        <span class="tab-count">${counts[k]}</span>
      </button>`).join('');

    tabs.querySelectorAll('.src-tab').forEach(t => t.addEventListener('click', () => {
      tabs.querySelectorAll('.src-tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      renderResults(t.dataset.source);
    }));
  }

  function renderResults(source) {
    const grid = $('#resultsGrid');
    const meta = Search.sourceMeta;
    const list = source === 'all' ? state.results : (state.resultsBySource[source] || []);

    grid.innerHTML = list.map(r => {
      const m = meta[r.source] || meta.web;
      return `
      <article class="result-card">
        <div class="rc-top">
          <span class="rc-source ${m.color}"><svg class="ic" aria-hidden="true"><use href="#${m.icon}"/></svg>${m.label}</span>
          <span class="rc-time"><svg class="ic" aria-hidden="true"><use href="#i-clock"/></svg>${UI.timeAgo(r.publishedAt) || 'recent'}</span>
        </div>
        <h3 class="rc-title"><a href="${UI.esc(r.url)}" target="_blank" rel="noopener noreferrer">${UI.esc(r.title)}</a></h3>
        <p class="rc-snippet">${UI.esc(r.snippet)}</p>
        <div class="rc-foot">
          <span class="rc-domain">${UI.esc(r.meta ? r.meta + ' · ' : '')}${UI.esc(UI.domain(r.url))}</span>
          <a class="rc-open" href="${UI.esc(r.url)}" target="_blank" rel="noopener noreferrer">Open<svg class="ic" aria-hidden="true"><use href="#i-ext"/></svg></a>
        </div>
      </article>`;
    }).join('');

    if (!list.length && source !== 'all') {
      grid.innerHTML = `<div class="empty-state"><div class="empty-orb"><svg class="ic" aria-hidden="true"><use href="#i-search"/></svg></div><h3>No ${meta[source].label} results</h3><p>Try a different query or enable more sources.</p></div>`;
    }
  }

  // ═══════════ SUGGESTIONS ═══════════
  async function handleSuggest() {
    const q = $('#searchInput').value.trim();
    const box = $('#suggestions');
    if (q.length < 2) { box.hidden = true; return; }
    try {
      const data = await fetch(
        `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(q)}&limit=6&namespace=0&format=json&origin=*`);
      const json = await data.json();
      const terms = json[1] || [];
      if (!terms.length) { box.hidden = true; return; }
      box.innerHTML = terms.map(t => `
        <button class="sug-item" data-q="${UI.esc(t)}">
          <svg class="ic" aria-hidden="true"><use href="#i-search"/></svg>${UI.esc(t)}
        </button>`).join('');
      box.hidden = false;
      box.querySelectorAll('.sug-item').forEach(b => b.addEventListener('click', () => {
        $('#searchInput').value = b.dataset.q;
        box.hidden = true;
        doSearch(b.dataset.q);
      }));
    } catch { box.hidden = true; }
  }

  // ═══════════ REPORT GENERATION ═══════════
  async function generateReport() {
    if (state.isGenerating) return;
    if (!state.results.length) { UI.toast('Search something first', 'info'); return; }

    state.isGenerating = true;
    state.reportSavedId = null;
    state.reportMarkdown = '';
    state.reportTitle = `Research report: ${state.lastQuery}`;
    $('#reportTitle').textContent = state.reportTitle;
    $('#reportMeta').innerHTML = `
      <span><svg class="ic" aria-hidden="true"><use href="#i-spark"/></svg>${UI.esc(providerLabel(state.settings.provider))}</span>
      <span><svg class="ic" aria-hidden="true"><use href="#i-clock"/></svg>${UI.fmtDate(Date.now())}</span>
      <span><svg class="ic" aria-hidden="true"><use href="#i-search"/></svg>${UI.esc(state.lastQuery)}</span>`;
    $('#reportBody').textContent = '';
    $('#reportSources').hidden = true;
    $('#savedBanner').hidden = true;

    // progress steps (clear any from a previous run)
    $('#progressSteps').innerHTML = '';
    $('#progressFill').style.width = '0%';
    const steps = [
      'Gathering & reading sources',
      'Synthesizing across sources',
      'Writing the report',
      'Finalizing citations',
    ];
    const stepEls = steps.map((s, i) => {
      const li = UI.el('li', i === 0 ? 'active' : '', `<span class="step-dot"><svg class="ic" aria-hidden="true"><use href="#i-check"/></svg></span>${s}`);
      $('#progressSteps').appendChild(li);
      return li;
    });
    $('#reportProgress').hidden = false;
    $('#progressFill').style.width = '0%';

    showView('report');
    UI.setLoading($('#generateBtn'), true, 'Generating…');

    const ac = new AbortController();
    let rendered = '';
    const renderThrottle = UI.debounce(() => {
      $('#reportBody').innerHTML = Markdown.render(rendered) + '<span class="caret"></span>';
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    }, 120);

    // Full-content read (RAG): fetch article text via serverless backend when enabled
    let fullContent = null;
    if (state.settings.contentReader && state.results.length && typeof Content !== 'undefined') {
      stepEls[0] && stepEls[0].classList.add('active');
      stepEls[0] && (stepEls[0].lastChild.textContent = 'Reading full articles…');
      const urls = state.results.map(r => r.url).slice(0, 8);
      fullContent = await Content.readArticles(urls);
      if (fullContent && Object.keys(fullContent).length) {
        const n = Object.keys(fullContent).length;
        stepEls[0] && (stepEls[0].lastChild.textContent = `Read ${n} full article${n === 1 ? '' : 's'}`);
      } else {
        // backend unavailable — fall back to snippets and say so
        stepEls[0] && (stepEls[0].lastChild.textContent = 'Full articles unavailable — using snippets');
      }
    }

    try {
      const { markdown, provider } = await AI.generate(state.lastQuery, state.results, state.settings, {
        onProgress: (label, pct) => {
          const stage = Object.values(AI.PROGRESS).indexOf(label);
          stepEls.forEach((el, i) => {
            el.classList.toggle('done', i < stage);
            el.classList.toggle('active', i === stage);
          });
          $('#progressFill').style.width = `${Math.round(pct * 100)}%`;
        },
        onChunk: chunk => {
          rendered += chunk;
          renderThrottle();
        },
      }, ac.signal, fullContent);

      // final clean render
      state.reportMarkdown = markdown;
      state.reportProvider = provider;
      $('#reportBody').innerHTML = Markdown.render(markdown);
      $('#reportMeta').innerHTML = `
        <span><svg class="ic" aria-hidden="true"><use href="#i-spark"/></svg>${UI.esc(providerLabel(provider))}</span>
        <span><svg class="ic" aria-hidden="true"><use href="#i-clock"/></svg>${UI.fmtDate(Date.now())}</span>
        <span><svg class="ic" aria-hidden="true"><use href="#i-search"/></svg>${UI.esc(state.lastQuery)}</span>`;
      if (provider === 'local') {
        UI.toast('AI providers unavailable — generated a smart summary from the sources instead.', 'info', 6000);
      }
      $('#progressFill').style.width = '100%';
      stepEls.forEach(el => { el.classList.add('done'); el.classList.remove('active'); });
      setTimeout(() => { $('#reportProgress').hidden = true; }, 900);

      state.reportSources = state.results.slice(0, 12);
      renderReportSources();
      await saveReportToLibrary(markdown, provider);
    } catch (e) {
      console.error('Report generation failed:', e);
      $('#reportBody').innerHTML = `<div class="empty-state">
        <div class="empty-orb"><svg class="ic" aria-hidden="true"><use href="#i-refresh"/></svg></div>
        <h3>Generation failed</h3>
        <p>${UI.esc(e.message || 'Unknown error')} — please retry, or switch AI provider in Settings.</p>
        <button class="btn btn-ghost" id="retryGenBtn">Try again</button>
      </div>`;
      $('#retryGenBtn').addEventListener('click', generateReport);
      $('#reportProgress').hidden = true;
    } finally {
      state.isGenerating = false;
      UI.setLoading($('#generateBtn'), false);
      UI.setLoading($('#regenerateBtn'), false);
    }
  }

  function renderReportSources() {
    const list = $('#reportSourcesList');
    $('#reportSources').hidden = false;
    list.innerHTML = state.reportSources.map(r => `
      <a class="src-chip" href="${UI.esc(r.url)}" target="_blank" rel="noopener noreferrer">
        <svg class="ic" aria-hidden="true"><use href="#i-ext"/></svg>
        <span class="chip-domain">${UI.esc(r.title.length > 60 ? r.title.slice(0, 57) + '…' : r.title)}</span>
      </a>`).join('');
  }

  function providerLabel(p) {
    return { pollinations: 'Pollinations', gemini: 'Gemini', groq: 'Groq', openrouter: 'OpenRouter', local: 'Auto summary' }[p] || p;
  }

  async function saveReportToLibrary(markdown, provider) {
    try {
      const report = {
        id: 'r-' + Date.now(),
        query: state.lastQuery,
        title: state.reportTitle,
        markdown,
        createdAt: Date.now(),
        provider: provider || state.settings.provider,
        sourceCount: state.results.length,
        sources: state.results.slice(0, 12).map(r => ({ title: r.title, url: r.url, source: r.source })),
      };
      await Storage.saveReport(report);
      state.reportSavedId = report.id;
      $('#savedBanner').hidden = false;
      refreshLibraryCount();
    } catch (e) {
      console.warn('Could not save report:', e);
    }
  }

  // ═══════════ COPY / DOWNLOAD ═══════════
  async function copyReport() {
    if (!state.reportMarkdown) return;
    const ok = await UI.copy(state.reportMarkdown);
    UI.toast(ok ? 'Report copied to clipboard' : 'Copy failed', ok ? 'ok' : 'err');
  }

  function downloadReport() {
    if (!state.reportMarkdown) return;
    UI.download(`aurora-report-${state.lastQuery.replace(/[^\w-]+/g, '-').slice(0, 40)}.md`, state.reportMarkdown);
    UI.toast('Report downloaded as .md');
  }

  // ═══════════ LIBRARY ═══════════
  async function renderLibrary() {
    const grid = $('#libraryGrid');
    const filter = ($('#librarySearch').value || '').toLowerCase();
    let reports;
    try { reports = await Storage.getAllReports(); } catch { reports = []; }

    $('#librarySub').textContent = reports.length
      ? `${reports.length} saved report${reports.length === 1 ? '' : 's'} — always available, even offline.`
      : 'Saved reports — always available, even offline.';

    $('#libraryEmpty').hidden = reports.length > 0;
    grid.hidden = reports.length === 0;

    const filtered = reports.filter(r =>
      !filter || (r.title || '').toLowerCase().includes(filter) || (r.query || '').toLowerCase().includes(filter));

    grid.innerHTML = filtered.map(r => {
      const snippet = (r.markdown || '').replace(/[#*_>`[\]-]/g, ' ').replace(/\s+/g, ' ').slice(0, 160);
      return `
      <button class="lib-card" data-id="${r.id}">
        <div class="lib-card-top">
          <span class="lib-badge ${state.online ? '' : 'offline'}">${state.online ? '● online' : '✓ offline'}</span>
          <span class="lib-date">${UI.timeAgo(r.createdAt)}</span>
        </div>
        <span class="lib-title">${UI.esc(r.title || r.query)}</span>
        <span class="lib-snippet">${UI.esc(snippet)}</span>
        <div class="lib-foot">
          <span class="lib-sources"><svg class="ic" aria-hidden="true"><use href="#i-globe"/></svg>${r.sourceCount || 0} sources · ${r.provider || 'ai'}</span>
          <span class="lib-del" data-del="${r.id}" role="button" aria-label="Delete report" title="Delete">
            <svg class="ic" aria-hidden="true"><use href="#i-trash"/></svg>
          </span>
        </div>
      </button>`;
    }).join('') || `<div class="empty-state" style="grid-column:1/-1"><h3>No matches</h3><p>No saved reports match "${UI.esc(filter)}".</p></div>`;

    grid.querySelectorAll('.lib-card').forEach(card => {
      card.addEventListener('click', e => {
        const del = e.target.closest('[data-del]');
        if (del) { e.stopPropagation(); deleteOneReport(del.dataset.del); return; }
        openSavedReport(card.dataset.id);
      });
    });
  }

  async function deleteOneReport(id) {
    try {
      await Storage.deleteReport(id);
      UI.toast('Report deleted', 'info');
      renderLibrary();
      refreshLibraryCount();
    } catch { UI.toast('Could not delete report', 'err'); }
  }

  async function openSavedReport(id) {
    try {
      const r = await Storage.getReport(id);
      if (!r) { UI.toast('Report not found', 'err'); return; }
      state.reportMarkdown = r.markdown;
      state.reportTitle = r.title || r.query;
      state.lastQuery = r.query || '';
      state.reportSources = r.sources || [];
      $('#reportTitle').textContent = state.reportTitle;
      $('#reportMeta').innerHTML = `
        <span><svg class="ic" aria-hidden="true"><use href="#i-clock"/></svg>${UI.fmtDate(r.createdAt)}</span>
        <span><svg class="ic" aria-hidden="true"><use href="#i-spark"/></svg>${r.provider || 'ai'}</span>
        <span><svg class="ic" aria-hidden="true"><use href="#i-search"/></svg>${UI.esc(r.query || '')}</span>`;
      $('#reportBody').innerHTML = Markdown.render(r.markdown);
      $('#reportProgress').hidden = true;
      $('#savedBanner').hidden = true;
      $('#reportSources').hidden = true;
      renderReportSources();
      showView('report');
    } catch (e) {
      console.error(e);
      UI.toast('Could not open report', 'err');
    }
  }

  async function clearLibrary() {
    if (!confirm('Delete ALL saved reports? This cannot be undone.')) return;
    try {
      await Storage.clearAll();
      UI.toast('Library cleared', 'info');
      renderLibrary();
      refreshLibraryCount();
    } catch { UI.toast('Could not clear library', 'err'); }
  }

  async function exportLibrary() {
    let reports;
    try { reports = await Storage.getAllReports(); } catch { reports = []; }
    if (!reports.length) { UI.toast('Nothing to export yet', 'info'); return; }
    const blob = JSON.stringify(reports.map(r => ({ ...r, exportedAt: new Date().toISOString() })), null, 2);
    UI.download(`aurora-library-${new Date().toISOString().slice(0, 10)}.json`, blob, 'application/json');
    UI.toast(`Exported ${reports.length} report${reports.length === 1 ? '' : 's'}`);
  }

  async function refreshLibraryCount() {
    try {
      const n = await Storage.count();
      $('#statReports').textContent = n;
    } catch { $('#statReports').textContent = '0'; }
  }

  // ═══════════ SETTINGS ═══════════
  function openSettings() {
    applySettingsToUI();
    $('#settingsModal').hidden = false;
  }
  function closeSettings() { $('#settingsModal').hidden = true; }

  // ═══════════ BACKEND STATUS ═══════════
  async function refreshBackendStatus() {
    const el = $('#backendStatus');
    if (!el) return;
    if (typeof Content === 'undefined') {
      el.textContent = 'Full-content reader unavailable in this build.';
      return;
    }
    if (!state.settings.contentReader) {
      el.textContent = 'Full-content reader is off — reports use search snippets only.';
      return;
    }
    // Content.isAvailable() never throws — it resolves false on any failure
    const ok = await Content.isAvailable();
    el.textContent = ok
      ? 'Serverless backend: connected — reports read full articles for richer analysis.'
      : 'Serverless backend: not detected (static hosting) — using search snippets. Deploy to Netlify for full-content reading.';
  }

  // ═══════════ CONNECTION ═══════════
  function updateConnection() {
    state.online = navigator.onLine !== false;
    $('#connPill').classList.toggle('offline', !state.online);
    $('#connText').textContent = state.online ? 'Online' : 'Offline';
    $('#offlineBanner').hidden = state.online;
    if (!state.online) UI.toast('You are offline — saved reports still work.', 'info', 4000);
    renderLibrary();
  }

  // ═══════════ TRENDING ═══════════
  function renderTrending() {
    $('#trendingChips').innerHTML = TRENDING.map(t =>
      `<button class="chip" data-q="${UI.esc(t)}">${UI.esc(t)}</button>`).join('');
  }

  // ═══════════ PWA ═══════════
  function registerSW() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => { /* non-fatal */ });
      });
    }
  }

  function openReportFromHash(hash) {
    const id = decodeURIComponent(hash);
    if (id) openSavedReport(id);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
