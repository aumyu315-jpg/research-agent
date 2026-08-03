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
    narratorVoice: 'en-US-EmmaMultilingualNeural',  // free neural narrator voice (Edge TTS)
    narrationMode: 'briefing',       // 'briefing' | 'deep' — news-anchor broadcast style
    perSource: 8,
    contentReader: true,           // fetch full article text via serverless backend
    autoRoute: true,               // detect query type & prioritize matching sources
    deepResearch: false,           // run the autonomous research planner before reports
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
    liveCat: 'top',
    liveStories: [],
    liveCatLoaded: null,   // category the currently displayed stories belong to
    liveUpdated: null,
    liveLoading: false,
    newsCountry: null,     // selected country code (null = global)
    newsQuery: null,       // active news topic search (null = live feed)
    chatMessages: [],      // [{ role, content }]
    chatBusy: false,
    ttsTrack: null,        // { text, title } — current audio source for voice/rate restart
    ttsToken: 0,           // increments on every Listen click — guards stale summary appends
    activePlan: null,      // autonomous research plan (Planner) used by the last deep research
    researchProcess: null, // { plan, stats, gaps, errors, evidence, confidence, limitations }
    researchRunning: false,
    planToken: 0,          // increments on every new search/research — guards stale async continuations
  };

  const CHAT_SUGGESTS = [
    'Summarize today\'s top stories',
    'Explain the biggest headline in simple terms',
    'What are the risks of AI regulation?',
    'Give me a 5-point briefing on climate change',
  ];
  const CHAT_STORE_KEY = 'aurora-chat';

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];

  // ═══════════ INIT ═══════════
  function init() {
    loadSettings();
    applySettingsToUI();
    renderTrending();
    populateCountries();
    bindEvents();
    updateConnection();
    window.addEventListener('online', updateConnection);
    window.addEventListener('offline', updateConnection);
    registerSW();
    refreshLibraryCount();
    initTts();
    initLive();
    if (typeof FX !== 'undefined') FX.init();
    if (location.hash.startsWith('#report=')) openReportFromHash(location.hash.slice(8));
  }

  function populateCountries() {
    const sel = $('#countrySelect');
    if (!sel || !Search.COUNTRIES) return;
    sel.innerHTML = `<option value="GLOBAL">🌐 Global (all countries)</option>` +
      Search.COUNTRIES.map(c => `<option value="${c.code}">${c.flag} ${UI.esc(c.name)}</option>`).join('');
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
    $('#narratorVoice').value = state.settings.narratorVoice || 'en-US-EmmaMultilingualNeural';
    syncModePickers();
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
    $('#deepResearch').checked = !!state.settings.deepResearch;
    const statEl = $('#statSources');
    if (statEl) statEl.textContent = Object.values(state.settings.sources).filter(Boolean).length;
    $('#geminiGroup').hidden = state.settings.provider !== 'gemini';
    $('#groqGroup').hidden = state.settings.provider !== 'groq';
    $('#openrouterGroup').hidden = state.settings.provider !== 'openrouter';
    $('.news-key-row').hidden = !state.settings.sources.news;
    refreshBackendStatus();
  }

  // ═══════════ EVENTS ═══════════
  function bindEvents() {
    // nav
    $('#brandBtn').addEventListener('click', () => showView('news'));
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
    $('#narratorVoice').addEventListener('change', e => {
      state.settings.narratorVoice = e.target.value || 'en-US-EmmaMultilingualNeural';
      saveSettings();
      syncNarrator();
    });
    $('#testNarratorBtn').addEventListener('click', testNarrator);
    $('#narrationModePick').addEventListener('change', e => {
      if (e.target.name === 'narrationMode') {
        state.settings.narrationMode = e.target.value === 'deep' ? 'deep' : 'briefing';
        saveSettings();
        syncModePickers();
      }
    });
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
    $('#deepResearch').addEventListener('change', e => {
      state.settings.deepResearch = e.target.checked;
      saveSettings();
    });
    $('#clearLibBtn').addEventListener('click', clearLibrary);

    // results & report
    $('#generateBtn').addEventListener('click', () => generateReport(null, { plan: state.settings.deepResearch }));
    $('#regenerateBtn').addEventListener('click', () => generateReport(null, { plan: false }));
    $('#deepResearchBtn').addEventListener('click', () => doDeepResearch($('#searchInput').value));
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

    // live news
    $('#liveRefreshBtn').addEventListener('click', () => { state.newsQuery = null; clearNewsSearch(); loadLiveFeed(state.liveCat); });
    $('#summaryBtn').addEventListener('click', summarizeFeed);
    $('#liveCats').addEventListener('click', e => {
      const tab = e.target.closest('.live-cat');
      if (!tab) return;
      $$('.live-cat').forEach(t => t.classList.toggle('active', t === tab));
      state.newsQuery = null;
      clearNewsSearch();
      loadLiveFeed(tab.dataset.cat);
    });

    // country selector + news topic search
    $('#countrySelect').addEventListener('change', e => {
      const code = e.target.value || null;
      state.newsCountry = code === 'GLOBAL' ? null : code;
      state.newsQuery = null;
      clearNewsSearch();
      loadLiveFeed(state.liveCat);
    });
    $('#newsSearchForm').addEventListener('submit', e => {
      e.preventDefault();
      doNewsSearch($('#newsSearchInput').value);
    });
    $('#newsClearBtn').addEventListener('click', () => {
      state.newsQuery = null;
      $('#newsSearchInput').value = '';
      clearNewsSearch();
      loadLiveFeed(state.liveCat);
    });

    // chat
    $('#chatForm').addEventListener('submit', e => { e.preventDefault(); sendChat(); });
    $('#chatClearBtn').addEventListener('click', clearChat);
    $('#chatSuggests').addEventListener('click', e => {
      const chip = e.target.closest('.chat-suggest-chip');
      if (chip) {
        $('#chatInput').value = chip.dataset.q;
        sendChat();
      }
    });

    // TTS listen buttons (event delegation: live cards, result cards)
    document.addEventListener('click', e => {
      const btn = e.target.closest('[data-listen]');
      if (!btn) return;
      const kind = btn.dataset.listen;
      const i = Number(btn.dataset.i || 0);
      if (kind === 'live') {
        const story = state.liveStories[i];
        if (story) listenToNews(story, btn);
      } else if (kind === 'results') {
        const r = state.results[i];
        if (r) listenToResult(r, btn);
      }
    });
    $('#listenReportBtn').addEventListener('click', listenToReport);

    // player bar controls
    $('#ttsPauseBtn').addEventListener('click', toggleTtsPause);
    $('#ttsStopBtn').addEventListener('click', stopTts);
    $('#ttsVoice').addEventListener('change', e => {
      TTS.setSettings({ voice: e.target.value });
      restartTtsTrack();
    });
    $('#ttsRate').addEventListener('change', e => {
      TTS.setSettings({ rate: Number(e.target.value) });
      restartTtsTrack();
    });
    // anchor player: live mode switch, chapter timeline, feedback
    $('#ttsModes').addEventListener('click', e => {
      const btn = e.target.closest('.tts-mode-btn');
      if (!btn) return;
      state.settings.narrationMode = btn.dataset.mode === 'deep' ? 'deep' : 'briefing';
      saveSettings();
      syncModePickers();
      restartTtsTrack();
    });
    $('#ttsPrevCh').addEventListener('click', () => TTS.skipScript(-1));
    $('#ttsNextCh').addEventListener('click', () => TTS.skipScript(1));
    $('#ttsChapters').addEventListener('click', e => {
      const dot = e.target.closest('.tts-chap');
      if (dot && dot.dataset.ch != null) TTS.jumpChapter(Number(dot.dataset.ch));
    });
    $('#ttsHelpful').addEventListener('click', () => sendNarrationFeedback('helpful'));
    $('#ttsNotHelpful').addEventListener('click', () => sendNarrationFeedback('not_helpful'));
    $('#ttsIssue').addEventListener('click', e => { e.stopPropagation(); toggleIssueMenu(); });
    $('#ttsIssueMenu').addEventListener('click', e => {
      const btn = e.target.closest('[data-issue]');
      if (!btn) return;
      if (typeof Anchor !== 'undefined') {
        Anchor.reportIssue(btn.dataset.issue, { title: state.ttsTrack ? state.ttsTrack.title : '' });
        UI.toast('Thanks — your feedback helps Aurora narrate better.', 'ok');
      }
      hideIssueMenu();
    });
    document.addEventListener('click', hideIssueMenu);
    if ('speechSynthesis' in window) {
      window.speechSynthesis.onvoiceschanged = populateTtsVoices;
    }
  }

  // ═══════════ TEXT-TO-SPEECH ═══════════
  function initTts() {
    TTS.init();
    const rate = TTS.getSettings().rate || 1;
    $('#ttsRate').value = String(rate);
    populateTtsVoices();
    populateNarratorVoices();
    syncNarrator();
  }

  // Free neural narrator voices (Microsoft Edge TTS via /api/tts/voices) — no keys
  async function populateNarratorVoices() {
    const sel = $('#narratorVoice');
    if (!sel) return;
    const fallback = [
      ['en-US-EmmaMultilingualNeural', 'Emma — US (multilingual)'],
      ['en-US-AriaNeural', 'Aria — US'],
      ['en-US-ChristopherNeural', 'Christopher — US'],
      ['en-US-GuyNeural', 'Guy — US'],
      ['en-US-JennyNeural', 'Jenny — US'],
      ['en-GB-SoniaNeural', 'Sonia — UK'],
      ['en-GB-RyanNeural', 'Ryan — UK'],
      ['en-IN-NeerjaNeural', 'Neerja — India'],
      ['en-IN-PrabhatNeural', 'Prabhat — India'],
      ['en-AU-NatashaNeural', 'Natasha — Australia'],
    ];
    let list = fallback;
    try {
      const res = await fetch('/api/tts/voices');
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.voices) && data.voices.length) {
          list = data.voices.map(v => [v.id, v.name]);
        }
      }
    } catch { /* fallback list */ }
    const saved = state.settings.narratorVoice || 'en-US-EmmaMultilingualNeural';
    sel.innerHTML = list.map(([id, name]) =>
      `<option value="${UI.esc(id)}" ${id === saved ? 'selected' : ''}>${UI.esc(name)}</option>`).join('');
    if (saved && !list.some(([id]) => id === saved)) {
      sel.value = 'en-US-EmmaMultilingualNeural';
      state.settings.narratorVoice = 'en-US-EmmaMultilingualNeural';
      saveSettings();
      syncNarrator();
    }
  }

  // Pass the narrator config to the TTS engine + refresh the settings status line
  function syncNarrator() {
    if (typeof TTS === 'undefined') return;
    TTS.setNarrator({
      voice: state.settings.narratorVoice || 'en-US-EmmaMultilingualNeural',
    });
    refreshNarratorStatus();
  }

  // Status hint in Settings: free neural narrator is ready by default
  async function refreshNarratorStatus() {
    const el = $('#narratorStatus');
    if (!el || typeof TTS === 'undefined') return;
    // verify the deployed backend actually serves /api/tts (free Edge TTS narrator)
    let backend = false;
    try {
      const res = await fetch('/api/tts/status', { method: 'GET' });
      if (res.ok) backend = (await res.json()).configured !== false;
    } catch { /* backend unreachable */ }
    el.textContent = (TTS.narratorEnabled() && backend)
      ? 'Narrator: free neural voice ✓ — Aurora reads news & reports aloud. Click “Test voice” to hear it.'
      : 'Narrator: using your browser\'s free voices (Edge TTS needs the deployed backend for the neural narrator).';
  }

  // Speak a short sample so users can compare narrator vs browser voice
  function testNarrator() {
    if (typeof TTS === 'undefined') return;
    const sample = 'Hello, I\'m Aurora, your research narrator. I can read news and reports aloud in my own voice.';
    const ok = TTS.speak(sample, { title: 'Narrator test' });
    if (!ok) UI.toast('Nothing to play — TTS unavailable in this browser.', 'info');
    showTtsPlayer('Narrator test');
  }

  function populateTtsVoices() {
    const sel = $('#ttsVoice');
    if (!sel) return;
    const voices = TTS.voices();
    const saved = TTS.getSettings().voice;
    sel.innerHTML = voices.map(v =>
      `<option value="${UI.esc(v.name)}" ${v.name === saved ? 'selected' : ''}>${UI.esc(v.name)} (${UI.esc(v.lang)})</option>`).join('');
    if (saved && voices.some(v => v.name === saved)) sel.value = saved;
    else if (voices.length) {
      const def = TTS.defaultVoice();
      if (def) sel.value = def.name;
    }
  }

  function showTtsPlayer(title) {
    $('#ttsTitle').textContent = title;
    $('#ttsPlayer').hidden = false;
    $('#ttsPlayer').classList.remove('paused');
    const isNarrator = typeof TTS !== 'undefined' && TTS.narratorEnabled();
    const now = $('#ttsNow');
    if (now) now.textContent = isNarrator ? 'Narrator' : 'Now listening';
    // the browser-voice dropdown is meaningless while the free neural narrator is active
    const voiceSel = $('#ttsVoice');
    if (voiceSel) {
      voiceSel.disabled = isNarrator;
      voiceSel.title = isNarrator ? 'The free neural narrator voice is used while active — pick another in Settings' : '';
    }
    syncModePickers();
    renderChapterDots();
    // allow feedback on every new track
    const helpful = $('#ttsHelpful');
    const notHelpful = $('#ttsNotHelpful');
    if (helpful) { helpful.disabled = false; helpful.classList.remove('sent'); }
    if (notHelpful) { notHelpful.disabled = false; notHelpful.classList.remove('sent'); }
  }

  function hideTtsPlayer() {
    $('#ttsPlayer').hidden = true;
    hideIssueMenu();
    $$('[data-listen].playing').forEach(b => b.classList.remove('playing'));
    const dots = $('#ttsChapters');
    if (dots) { dots.innerHTML = ''; dots.hidden = true; }
    const chapName = $('#ttsChapName');
    if (chapName) chapName.textContent = '';
  }

  // Plain single-chapter track (instant lines, narrator test)
  function speakTrack(text, title, onStateChange) {
    if (!TTS.supported()) { UI.toast('Audio isn\'t supported in this browser.', 'err'); return; }
    state.ttsTrack = { kind: 'plain', title, content: text, mode: state.settings.narrationMode };
    showTtsPlayer(title);
    const done = mode => {
      if (mode === 'ended') {
        hideTtsPlayer();
        state.ttsTrack = null;
      }
      if (onStateChange) onStateChange(mode);
    };
    const ok = TTS.speak(text, { title, onStateChange: done });
    if (!ok) UI.toast('Nothing to play for this item.', 'info');
  }

  // ── Anchor narration: chaptered broadcast scripts ──
  function syncModePickers() {
    const mode = state.settings.narrationMode === 'deep' ? 'deep' : 'briefing';
    $$('#ttsModes .tts-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    const radios = $$('#narrationModePick input');
    if (radios.length) radios.forEach(r => { r.checked = r.value === mode; });
  }

  function buildTrackChapters(track) {
    if (typeof Anchor === 'undefined') return [{ title: '', text: track.content }];
    if (track.kind === 'report') return Anchor.reportChapters(track.content, track.title, track.mode || 'deep').chapters;
    if (track.kind === 'plain') return [{ title: '', text: track.content }];
    return Anchor.buildScript({ title: track.title, source: track.source || '', text: track.content, mode: track.mode }).chapters;
  }

  function speakScriptTrack(chapters, title, meta = {}) {
    if (!TTS.supported()) { UI.toast('Audio isn\'t supported in this browser.', 'err'); return; }
    const track = {
      kind: meta.kind || 'plain',
      title,
      content: meta.content != null ? meta.content : (chapters || []).map(c => c.text).join(' '),
      mode: meta.mode || state.settings.narrationMode,
      source: meta.source || '',
      _chapters: chapters,
    };
    state.ttsTrack = track;
    state.ttsSessionStart = Date.now();
    showTtsPlayer(title);
    const done = mode => {
      if (mode === 'ended') {
        recordTtsSession(true);
        hideTtsPlayer();
        state.ttsTrack = null;
      }
      if (meta.onStateChange) meta.onStateChange(mode);
    };
    const ok = TTS.speakScript(chapters, { title, onStateChange: done, onChapter: renderChapterDots });
    if (!ok) UI.toast('Nothing to play for this item.', 'info');
  }

  function renderChapterDots() {
    const wrap = $('#ttsChapters');
    const nameEl = $('#ttsChapName');
    if (!wrap || !nameEl) return;
    const st = TTS.state();
    const n = st && st.chapters ? st.chapters : 0;
    if (n < 2) { wrap.hidden = true; nameEl.textContent = ''; return; }
    wrap.hidden = false;
    const active = st.chapter != null ? st.chapter : 0;
    wrap.innerHTML = Array.from({ length: n }, (_, i) =>
      `<button class="tts-chap ${i < active ? 'done' : ''} ${i === active ? 'active' : ''}" data-ch="${i}" title="Section ${i + 1}" aria-label="Section ${i + 1}"></button>`).join('');
    const chapters = state.ttsTrack && state.ttsTrack._chapters;
    nameEl.textContent = chapters && chapters[active] ? chapters[active].title : `Section ${active + 1}`;
  }

  function recordTtsSession(completed) {
    if (typeof Anchor === 'undefined' || !state.ttsSessionStart) return;
    const seconds = Math.round((Date.now() - state.ttsSessionStart) / 1000);
    Anchor.recordSession({
      title: state.ttsTrack ? state.ttsTrack.title : '',
      mode: state.ttsTrack ? state.ttsTrack.mode : state.settings.narrationMode,
      seconds,
      completed,
    });
    state.ttsSessionStart = null;
  }

  function sendNarrationFeedback(kind) {
    if (typeof Anchor === 'undefined') return;
    Anchor.recordFeedback(kind, { title: state.ttsTrack ? state.ttsTrack.title : '' });
    const btn = kind === 'helpful' ? $('#ttsHelpful') : $('#ttsNotHelpful');
    if (btn) { btn.classList.add('sent'); btn.disabled = true; }
    UI.toast(kind === 'helpful' ? 'Glad it helped! ✓' : 'Thanks — we\'ll keep improving.', 'ok');
  }

  function toggleIssueMenu() {
    const menu = $('#ttsIssueMenu');
    if (menu) menu.hidden = !menu.hidden;
  }
  function hideIssueMenu() {
    const m = $('#ttsIssueMenu');
    if (m) m.hidden = true;
  }

  function restartTtsTrack() {
    if (!state.ttsTrack || !TTS.state()) return;
    // re-speak from the top with the current voice/rate/mode (rebuilds the script)
    const t = state.ttsTrack;
    t.mode = state.settings.narrationMode;
    const chapters = buildTrackChapters(t);
    if (!chapters || !chapters.length) return;
    speakScriptTrack(chapters, t.title, { kind: t.kind, content: t.content, mode: t.mode, source: t.source });
  }

  function toggleTtsPause() {
    const st = TTS.state();
    if (!st) return;
    if (st.paused) { TTS.resume(); $('#ttsPlayer').classList.remove('paused'); }
    else { TTS.pause(); $('#ttsPlayer').classList.add('paused'); }
  }

  function stopTts() {
    recordTtsSession(false);
    TTS.stop();
    hideTtsPlayer();
    state.ttsTrack = null;
  }

  // News story: speak an instant anchor line, then scrape the FULL article and
  // narrate a professional broadcast script (briefing or deep dive) built from an
  // elegant AI summary — never raw article text.
  async function listenToNews(story, btn) {
    const title = story.title || 'News story';
    const token = ++state.ttsToken;
    const instant = typeof Anchor !== 'undefined'
      ? Anchor.instantBriefing(title, story.snippet || '')
      : `${story.title || ''}. ${story.snippet || ''}`;
    speakTrack(instant, title);
    markListening(btn);
    const url = story.url;
    if (!url || typeof Content === 'undefined' || state.settings.contentReader === false) return;
    setPreparing(btn, true);
    try {
      const data = await Content.summarizeArticle(url, title);
      if (state.ttsToken !== token) { setPreparing(btn, false); return; } // user switched tracks — drop stale summary
      const text = data && data.summary ? data.summary : null;
      if (text) {
        await narrateScriptFromText(text, title, token, story.meta || '', 'news');
      } else {
        const texts = await Content.readArticles([url]);
        const full = texts && texts[url];
        // cap the raw fallback so a long article doesn't become a wall of text
        if (full && state.ttsToken === token) await narrateScriptFromText(full.slice(0, 4000), title, token, story.meta || '', 'news');
      }
      setPreparing(btn, false);
    } catch { setPreparing(btn, false); /* audio stays with the instant line */ }
  }

  // Research result: speak an instant anchor line, then narrate a broadcast script
  async function listenToResult(r, btn) {
    const title = r.title || 'Search result';
    const token = ++state.ttsToken;
    const instant = typeof Anchor !== 'undefined'
      ? Anchor.instantBriefing(title, r.snippet || '')
      : `${title}. ${r.snippet || ''}`;
    speakTrack(instant, title);
    markListening(btn);
    const url = r.url;
    if (!url || typeof Content === 'undefined' || state.settings.contentReader === false) return;
    setPreparing(btn, true);
    try {
      const data = await Content.summarizeArticle(url, title);
      if (state.ttsToken !== token) { setPreparing(btn, false); return; } // user switched tracks
      const text = data && data.summary ? data.summary : null;
      if (text) {
        await narrateScriptFromText(text, title, token, r.meta || '', 'result');
      } else {
        const texts = await Content.readArticles([url]);
        const full = texts && texts[url];
        // cap the raw fallback so a long article doesn't become a wall of text
        if (full && state.ttsToken === token) await narrateScriptFromText(full.slice(0, 4000), title, token, r.meta || '', 'result');
      }
      setPreparing(btn, false);
    } catch { setPreparing(btn, false); }
  }

  // Build a broadcast script from narration text and start it as a chaptered track.
  // Tries the AI-assisted script first (better phrasing through the provider chain);
  // falls back to the deterministic heuristic builder when the AI is unreachable.
  // Both steps are token-guarded so a track switch mid-generation is never spoken.
  async function narrateScriptFromText(text, title, token, source, kind) {
    if (state.ttsToken !== token) return; // user switched tracks — drop stale script
    const mode = state.settings.narrationMode;
    let script = null;
    // AI-assisted phrasing — silent failure, never blocks playback
    if (typeof Anchor !== 'undefined' && typeof AI !== 'undefined') {
      try {
        script = await Anchor.buildAiScript({ title, source, text, mode, ai: AI, settings: state.settings });
      } catch { script = null; }
    }
    if (!script && typeof Anchor !== 'undefined') {
      script = Anchor.buildScript({ title, source, text, mode });
    }
    if (state.ttsToken !== token) return; // user switched tracks while AI was writing
    if (script && script.chapters && script.chapters.length) {
      speakScriptTrack(script.chapters, title, { kind, content: text, mode, source });
    } else if (state.ttsToken === token) {
      speakTrack(text, `${title} — full story`);
    }
  }

  // Toggle a "Preparing…" state on a Listen button while the article is being
  // scraped + summarized, so the flow never feels unresponsive.
  function setPreparing(btn, on) {
    if (!btn) return;
    if (on) {
      if (btn.dataset.origHtml == null) btn.dataset.origHtml = btn.innerHTML;
      btn.classList.add('preparing');
      btn.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-refresh"/></svg>Preparing…';
    } else {
      btn.classList.remove('preparing');
      if (btn.dataset.origHtml != null) {
        btn.innerHTML = btn.dataset.origHtml;
        delete btn.dataset.origHtml;
      }
    }
  }

  // AI report: narrate the markdown as a chaptered deep dive — Aurora-authored,
  // so the full structure is fair game (headings become broadcast sections).
  function listenToReport() {
    if (!state.reportMarkdown) { UI.toast('No report to listen to yet.', 'info'); return; }
    narrateReport(state.reportMarkdown, state.reportTitle || 'Research report');
  }

  function narrateReport(markdown, title) {
    const mode = 'deep'; // reports are Aurora-owned — always the full structure
    const script = typeof Anchor !== 'undefined'
      ? Anchor.reportChapters(markdown, title, mode)
      : null;
    if (script && script.chapters && script.chapters.length) {
      speakScriptTrack(script.chapters, title, { kind: 'report', content: markdown, mode });
    } else {
      speakTrack(markdown, title);
    }
  }

  function markListening(btn) {
    $$('[data-listen].playing').forEach(b => b.classList.remove('playing'));
    if (btn) btn.classList.add('playing');
  }

  // Pre-generation: silently warm the top story's summary (server caches it for an
  // hour) so the most popular item starts narrating instantly — never blocks UI.
  function warmTopStory() {
    if (!state.online || state.settings.contentReader === false || typeof Content === 'undefined') return;
    const s = state.liveStories && state.liveStories[0];
    if (!s || !s.url) return;
    if (state._warmedUrl === s.url) return;
    state._warmedUrl = s.url;
    setTimeout(() => { Content.summarizeArticle(s.url, s.title).catch(() => {}); }, 2500);
  }

  // ═══════════ CHAT ═══════════
  function restoreChat() {
    try {
      const saved = JSON.parse(localStorage.getItem(CHAT_STORE_KEY) || '[]');
      if (Array.isArray(saved)) state.chatMessages = saved.slice(-20);
    } catch { /* ignore */ }
    renderChatSuggestions();
    renderChat();
  }

  function persistChat() {
    try { localStorage.setItem(CHAT_STORE_KEY, JSON.stringify(state.chatMessages.slice(-20))); } catch { /* ignore */ }
  }

  function renderChatSuggestions() {
    $('#chatSuggests').innerHTML = CHAT_SUGGESTS.map(q =>
      `<button class="chat-suggest-chip" data-q="${UI.esc(q)}">${UI.esc(q)}</button>`).join('');
  }

  function renderChat() {
    const box = $('#chatMessages');
    if (!state.chatMessages.length) {
      box.innerHTML = `<div class="chat-msg ai typing">Hi! I'm Aurora — ask me anything about the news, a topic you're researching, or anything else. 👋</div>`;
      return;
    }
    box.innerHTML = state.chatMessages.map(m => m.role === 'user'
      ? `<div class="chat-msg user"><p>${UI.esc(m.content)}</p></div>`
      : `<div class="chat-msg ai"><div class="markdown-body">${Markdown.render(m.content)}</div></div>`
    ).join('');
    box.scrollTop = box.scrollHeight;
  }

  async function sendChat() {
    const input = $('#chatInput');
    const text = (input.value || '').trim();
    if (!text || state.chatBusy) return;
    state.chatBusy = true;
    input.value = '';
    state.chatMessages.push({ role: 'user', content: text });
    persistChat();
    renderChat();

    const box = $('#chatMessages');
    const aiMsg = document.createElement('div');
    aiMsg.className = 'chat-msg ai';
    aiMsg.innerHTML = '<div class="markdown-body"><span class="caret"></span></div>';
    box.appendChild(aiMsg);
    box.scrollTop = box.scrollHeight;

    let rendered = '';
    const paint = UI.debounce(() => {
      aiMsg.querySelector('.markdown-body').innerHTML = Markdown.render(rendered) + '<span class="caret"></span>';
      box.scrollTop = box.scrollHeight;
    }, 120);

    const sendBtn = $('#chatForm .chat-send');
    sendBtn.disabled = true;
    try {
      const { markdown, provider } = await AI.chat(state.chatMessages, state.settings, {
        onChunk: chunk => { rendered += chunk; paint(); },
      });
      state.chatMessages.push({ role: 'assistant', content: markdown });
      persistChat();
      aiMsg.querySelector('.markdown-body').innerHTML = Markdown.render(markdown);
      if (provider === 'local') UI.toast('AI providers unreachable — offline summary mode.', 'info', 4200);
    } catch (e) {
      aiMsg.innerHTML = `<div class="chat-msg-err">⚠ ${UI.esc(e.message || 'Could not reach the AI.')}</div>`;
    } finally {
      state.chatBusy = false;
      sendBtn.disabled = false;
      box.scrollTop = box.scrollHeight;
    }
  }

  function clearChat() {
    state.chatMessages = [];
    persistChat();
    renderChat();
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

  // ═══════════ LIVE NEWS ═══════════
  function initLive() {
    restoreChat();
    loadLiveFeed('top');
    loadTicker();
    // auto-refresh: every 5 min, only while visible, online, and on the news view
    setInterval(() => {
      if (!state.online || document.visibilityState !== 'visible') return;
      const active = $$('[data-view-panel]').find(v => !v.hidden);
      if (active && active.id === 'view-news' && !state.newsQuery) {
        loadLiveFeed(state.liveCat, true);
        loadTicker();
      }
    }, 5 * 60 * 1000);
  }

  function clearNewsSearch() {
    $('#newsSearchInput').value = '';
    $('#newsClearBtn').hidden = true;
    updateNewsModeChip();
  }

  function updateNewsModeChip() {
    const chip = $('#newsModeChip');
    if (!chip) return;
    const country = state.newsCountry ? Search.countryName(state.newsCountry) : 'Global';
    const catLabel = Search.LIVE_CATS[state.liveCat] ? Search.LIVE_CATS[state.liveCat].label : 'Top stories';
    chip.innerHTML = `<svg class="ic" aria-hidden="true"><use href="#i-globe"/></svg> ${UI.esc(country)} · ${UI.esc(state.newsQuery || catLabel)}`;
  }

  // News topic search: latest news for a query (country-scoped when selected)
  async function doNewsSearch(query) {
    query = (query || '').trim();
    if (!query) return;
    if (state.liveLoading) return;
    state.liveLoading = true;
    state._warmedUrl = null;
    state.newsQuery = query;
    $('#newsClearBtn').hidden = false;
    $('#newsSearchInput').value = query;
    $('#liveBadgeText').textContent = 'Searching';
    $('#liveTitle').textContent = `News · ${query}`;
    $('#liveEmpty').hidden = true;
    $('#liveGrid').innerHTML = liveSkeleton(6);
    try {
      const res = await Search.searchNews(query, state.settings, state.newsCountry);
      state.liveStories = res.results;
      state.liveCatLoaded = state.liveCat;
      state.liveUpdated = Date.now();
      updateNewsModeChip();
      renderLiveFeed();
      warmTopStory();
      if (!res.results.length) {
        $('#liveEmpty').hidden = false;
        $('#liveEmptyMsg').textContent = `No recent news for "${query}". Try different keywords.`;
      }
    } catch {
      $('#liveEmpty').hidden = false;
      $('#liveEmptyMsg').textContent = "Couldn't fetch news for that topic. Check your connection.";
    } finally {
      state.liveLoading = false;
      $('#liveBadgeText').textContent = 'Live';
    }
  }

  async function loadLiveFeed(cat, silent) {
    if (state.liveLoading) return;
    state.liveLoading = true;
    state.liveCat = cat;
    state._warmedUrl = null; // re-evaluate which story to pre-warm for this feed
    const grid = $('#liveGrid');
    const catMeta = Search.LIVE_CATS[cat];
    if (catMeta) $('#liveTitle').textContent = catMeta.label;
    if (!silent) grid.innerHTML = liveSkeleton(6);
    $('#liveEmpty').hidden = true;
    $('#liveBadgeText').textContent = 'Updating';
    updateNewsModeChip();
    try {
      const res = await Search.liveNews(cat, state.settings, state.newsCountry);
      state.liveStories = res.results;
      state.liveCatLoaded = cat;
      state.liveUpdated = Date.now();
      renderLiveFeed();
      warmTopStory();
    } catch {
      // keep last good stories on a silent (auto-refresh) failure or same-category retry;
      // only show the empty state when the displayed stories wouldn't match the active tab
      if (silent || state.liveCatLoaded === cat) {
        renderLiveFeed();
      } else {
        state.liveStories = [];
        $('#liveEmpty').hidden = false;
        $('#liveEmptyMsg').textContent = "Couldn't reach the news sources. Check your connection and try again.";
      }
    } finally {
      state.liveLoading = false;
      $('#liveBadgeText').textContent = 'Live';
    }
  }

  function liveSkeleton(n = 6) {
    return Array.from({ length: n }, () => `
      <article class="live-card is-skeleton">
        <div class="lc-top">
          <div class="sk" style="width:76px;height:16px"></div>
          <div class="sk" style="width:48px;height:14px;margin-left:auto"></div>
        </div>
        <div class="sk" style="width:94%;height:16px"></div>
        <div class="sk" style="width:62%;height:16px"></div>
        <div class="lc-foot"><div class="sk" style="width:38%;height:12px"></div></div>
      </article>`).join('');
  }

  function renderLiveFeed() {
    const grid = $('#liveGrid');
    const stories = state.liveStories;
    $('#liveUpdated').textContent = stories.length
      ? `Updated ${UI.timeAgo(state.liveUpdated)} · ${stories.length} stories`
      : '';
    $('#liveEmpty').hidden = stories.length > 0;
    grid.innerHTML = stories.map((r, i) => `
      <article class="live-card">
        <div class="lc-top">
          <span class="lc-outlet"><svg class="ic" aria-hidden="true"><use href="#i-news"/></svg>${UI.esc(r.meta || 'News')}</span>
          ${r.flag ? `<span class="lc-loc"><span class="flag">${UI.esc(r.flag)}</span>${UI.esc(r.location || r.country || '')}</span>` : ''}
          <span class="lc-time"><svg class="ic" aria-hidden="true"><use href="#i-clock"/></svg>${UI.timeAgo(r.publishedAt) || (r.publishedAt ? UI.fmtDate(r.publishedAt) : 'recent')}</span>
        </div>
        <h3 class="lc-title"><a href="${UI.esc(r.url)}" target="_blank" rel="noopener noreferrer">${UI.esc(r.title)}</a></h3>
        ${r.snippet ? `<p class="lc-snippet">${UI.esc(r.snippet)}</p>` : ''}
        <div class="lc-foot">
          <span class="lc-domain">${UI.esc(UI.domain(r.url))}</span>
          <span class="lc-foot-actions">
            <button class="listen-btn" data-listen="live" data-i="${i}" title="Listen"><svg class="ic" aria-hidden="true"><use href="#i-volume"/></svg>Listen</button>
            <a class="lc-open" href="${UI.esc(r.url)}" target="_blank" rel="noopener noreferrer">Read<svg class="ic" aria-hidden="true"><use href="#i-ext"/></svg></a>
          </span>
        </div>
      </article>`).join('');
  }

  // AI Summary: run the full AI report pipeline over the current news (country-aware)
  async function summarizeFeed() {
    if (!state.liveStories.length) { UI.toast('No stories yet — refresh or check connection.', 'info'); return; }
    const country = state.newsCountry ? Search.countryName(state.newsCountry) : 'the world';
    const scope = state.newsQuery ? `Latest news: ${state.newsQuery}` : `Daily news — ${country}`;
    state.lastQuery = `${scope} — ${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}`;
    state.results = state.liveStories.map(r => ({ ...r, source: 'news' }));
    state.resultsBySource = groupBySource(state.results);
    state.detected = 'news';
    $('#searchInput').value = state.lastQuery;
    generateReport(`AI News Summary — ${scope}`, { plan: false });
  }



  // ═══════════ LIVE TICKER ═══════════
  async function loadTicker() {
    try {
      const [markets, weather] = await Promise.all([
        Search.liveMarkets(6).catch(() => []),
        Search.liveWeather().catch(() => []),
      ]);
      renderTicker(markets, weather);
    } catch { /* ticker is optional */ }
  }

  function renderTicker(markets, weather) {
    const track = $('#tickerTrack');
    const ticker = $('#liveTicker');
    if (!track || !ticker) return;
    const parts = [];
    for (const m of markets) {
      const up = (m.change24h || 0) >= 0;
      parts.push(`<span class="tk-item"><a href="${UI.esc(m.url)}" target="_blank" rel="noopener noreferrer"><span class="tk-sym">${UI.esc(m.symbol)}</span><span class="tk-price">$${fmtPrice(m.price)}</span><span class="tk-chg ${up ? 'up' : 'down'}"><svg class="ic" aria-hidden="true"><use href="#${up ? 'i-up' : 'i-down'}"/></svg>${Math.abs(m.change24h || 0).toFixed(2)}%</span></a></span>`);
    }
    if (weather.length) parts.push('<span class="tk-div"></span>');
    for (const w of weather) {
      parts.push(`<span class="tk-item"><a href="${UI.esc(w.url)}" target="_blank" rel="noopener noreferrer"><span class="tk-city">${UI.esc(w.city)}</span><span>${UI.esc(w.label)}</span><span class="tk-temp">${w.temp != null ? w.temp + '°C' : '—'}</span></a></span>`);
    }
    if (!parts.length) { ticker.hidden = true; return; }
    const html = `<div class="ticker-inner">${parts.join('')}${parts.join('')}</div>`;
    $('#tickerUpdated').textContent = UI.timeAgo(Date.now());
    // skip rebuild when nothing changed so the marquee animation never jumps
    if (track.innerHTML === html) { ticker.hidden = false; return; }
    track.innerHTML = html;
    ticker.hidden = false;
  }

  function fmtPrice(p) {
    if (p == null) return '—';
    if (p >= 1000) return p.toLocaleString(undefined, { maximumFractionDigits: 0 });
    return p.toLocaleString(undefined, { maximumFractionDigits: p < 1 ? 6 : 2 });
  }

  // ═══════════ SEARCH ═══════════
  async function doSearch(query) {
    query = (query || '').trim();
    if (!query) { UI.toast('Type something to search', 'info'); return; }

    state.lastQuery = query;
    state.results = [];
    resetResearchPlanUI();
    state.planToken++; // invalidate any in-flight deep research
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

    grid.innerHTML = list.map((r, i) => {
      const m = meta[r.source] || meta.web;
      return `
      <article class="result-card">
        <div class="rc-top">
          <span class="rc-source ${m.color}"><svg class="ic" aria-hidden="true"><use href="#${m.icon}"/></svg>${m.label}</span>
          ${trustChipHtml(r)}
          <span class="rc-time"><svg class="ic" aria-hidden="true"><use href="#i-clock"/></svg>${UI.timeAgo(r.publishedAt) || 'recent'}</span>
        </div>
        <h3 class="rc-title"><a href="${UI.esc(r.url)}" target="_blank" rel="noopener noreferrer">${UI.esc(r.title)}</a></h3>
        <p class="rc-snippet">${UI.esc(r.snippet)}</p>
        <div class="rc-foot">
          <span class="rc-domain">${UI.esc(r.meta ? r.meta + ' · ' : '')}${UI.esc(UI.domain(r.url))}</span>
          <span class="rc-foot-actions">
            <button class="listen-btn" data-listen="results" data-i="${i}" title="Listen"><svg class="ic" aria-hidden="true"><use href="#i-volume"/></svg>Listen</button>
            <a class="rc-open" href="${UI.esc(r.url)}" target="_blank" rel="noopener noreferrer">Open<svg class="ic" aria-hidden="true"><use href="#i-ext"/></svg></a>
          </span>
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

  // ═══════════ AUTONOMOUS RESEARCH PLANNER ═══════════
  // Deep Research entry point: plan → parallel searches → gap fill → report
  async function doDeepResearch(query) {
    query = (query || '').trim();
    if (!query) { UI.toast('Type a research question first', 'info'); return; }
    if (state.researchRunning) return;
    state.lastQuery = query;
    state.results = [];
    $('#searchInput').value = query;
    const done = await runPlannedResearch(query, { merge: false });
    if (!done) return; // superseded by a newer search/research
    if (!state.results.length) {
      $('#resultsEmpty').hidden = false;
      $('#resultsEmptyMsg').textContent = `Nothing found for "${query}". Try different keywords or check your connection.`;
      return;
    }
    generateReport(null, { plan: true });
  }

  // Autonomous research run: create plan, show live progress, search each aspect
  // in parallel, detect + fill knowledge gaps, then compute evidence confidence.
  async function runPlannedResearch(query, opts = {}) {
    if (state.researchRunning) return false;
    const token = ++state.planToken; // this run owns the UI until a newer search/research starts
    state.researchRunning = true;
    state.researchProcess = null;
    try {
      state.activePlan = null;
      $('#generateBtn').disabled = true;
      showView('results');
      $('#resultsQuery').textContent = query;
      $('#resultsMeta').textContent = 'Planning research…';
      $('#resultsEmpty').hidden = true;
      $('#resultsLoading').hidden = true;
      $('#detectedBadge').hidden = true;
      $('#sourceTabs').innerHTML = '';
      $('#resultsGrid').innerHTML = '';
      const panel = $('#researchPlanPanel');
      if (panel) { panel.hidden = true; }
      $('#rpStats').hidden = true;

      setPlanStatus('Creating research plan…');
      setPlanProgress(0.06);

      const out = await Planner.runResearch(query, state.settings, {
        onPlan(plan) { showPlanPanel(plan); setPlanProgress(0.15); },
        onStage(stage) {
          const labels = {
            plan: 'Creating research plan…',
            search: 'Running parallel searches…',
            gaps: 'Analyzing knowledge gaps…',
            merge: 'Merging & verifying evidence…',
          };
          setPlanStatus(labels[stage] || 'Working…');
          if (stage === 'search') setPlanProgress(0.32);
          else if (stage === 'gaps') setPlanProgress(0.62);
          else if (stage === 'merge') setPlanProgress(0.86);
        },
        onAspect(aspect, i, status) { updateAspectStatus(aspect, status); },
        onGap(gap) {
          setPlanStatus(`Knowledge gap: ${(gap.reason || 'low coverage').toLowerCase()} — running follow-up…`);
        },
        onGapsFilled(filled) {
          setPlanStatus(filled.length ? 'Gaps filled — verifying evidence…' : 'No gaps to fill.');
        },
      });

      // A newer search/research superseded this run — drop its continuation
      if (token !== state.planToken) return false;

      state.activePlan = out.plan;
      state.results = opts.merge && state.results.length
        ? Planner.dedupe([...state.results, ...out.results])
        : out.results;
      state.resultsBySource = groupBySource(state.results);
      state.detected = null;
      state.researchProcess = {
        plan: out.plan,
        stats: out.stats,
        gaps: out.gaps,
        errors: out.errors,
        evidence: out.evidence,
        confidence: out.confidence,
        limitations: out.limitations,
      };

      setPlanStatus('Research complete', false);
      setPlanProgress(1);
      const ev = out.evidence;
      const statsEl = $('#rpStats');
      if (statsEl) {
        statsEl.hidden = false;
        statsEl.innerHTML = [
          `<span class="rp-stat">${out.stats.queriesRun} query${out.stats.queriesRun === 1 ? '' : 's'} run</span>`,
          `<span class="rp-stat">${out.results.length} result${out.results.length === 1 ? '' : 's'}</span>`,
          `<span class="rp-stat">${out.stats.gapsFound} gap${out.stats.gapsFound === 1 ? '' : 's'} · ${out.stats.gapsFilled} filled</span>`,
          `<span class="rp-stat">🟢 ${ev.consensusCount} consensus · 🔴 ${ev.contradictionCount} contradiction</span>`,
          `<span class="rp-stat">${Math.round(out.stats.durationMs / 1000)}s</span>`,
        ].join('');
      }

      if (!out.results.length) {
        $('#resultsMeta').textContent = 'No results found';
      } else {
        $('#resultsMeta').textContent =
          `${out.results.length} result${out.results.length === 1 ? '' : 's'} across ${out.plan.aspects.length} research aspect${out.plan.aspects.length === 1 ? '' : 's'} · ${Math.round(out.evidence.confidence * 100)}% confidence`;
        renderSourceTabs();
        renderResults('all');
        $('#generateBtn').disabled = false;
      }
      return true;
    } finally {
      state.researchRunning = false;
    }
  }

  function resetResearchPlanUI() {
    state.activePlan = null;
    state.researchProcess = null;
    const panel = $('#researchPlanPanel');
    if (panel) panel.hidden = true;
    const proc = $('#researchProcessPanel');
    if (proc) proc.hidden = true;
  }

  function showPlanPanel(plan) {
    const panel = $('#researchPlanPanel');
    if (!panel) return;
    $('#rpTitle').textContent = plan.title || 'Research plan';
    const intent = $('#rpIntent');
    intent.hidden = false;
    intent.innerHTML = `<svg class="ic" aria-hidden="true"><use href="#i-brain"/></svg> ${UI.esc(plan.intentLabel || 'Research')} intent · plan by ${plan.origin === 'ai' ? 'AI' : 'heuristics'}`;
    $('#rpAspects').innerHTML = (plan.aspects || []).map((a, i) => `
      <li class="rp-aspect" data-aspect="${a.id}">
        <span class="rp-a-dot">${i + 1}</span>
        <span class="rp-a-info">
          <span class="rp-a-q">${UI.esc(a.question)}</span>
          <span class="rp-a-query">${UI.esc(a.queries.join(' · '))}</span>
        </span>
        <span class="rp-a-meta">queued</span>
      </li>`).join('');
    panel.hidden = false;
  }

  function updateAspectStatus(aspect, status) {
    const li = $(`#rpAspects [data-aspect="${aspect.id}"]`);
    if (!li) return;
    li.className = 'rp-aspect ' + (status === 'done' ? (aspect.gapFilled ? 'gap done' : 'done') : status);
    const meta = li.querySelector('.rp-a-meta');
    if (!meta) return;
    if (status === 'searching') meta.textContent = 'searching…';
    else if (status === 'error') meta.textContent = 'no results';
    else if (aspect.resultCount != null) meta.textContent = aspect.gapFilled
      ? `${aspect.resultCount} results · gap filled`
      : `${aspect.resultCount} results`;
  }

  function setPlanStatus(text, spinner = true) {
    const el = $('#rpStatus');
    if (!el) return;
    el.innerHTML = spinner ? `<span class="spinner"></span>${UI.esc(text)}` : UI.esc(text);
  }

  function setPlanProgress(pct) {
    const f = $('#rpProgressFill');
    if (f) f.style.width = `${Math.round(pct * 100)}%`;
  }

  // Compact trust-tier chip for a result card
  function trustChipHtml(r) {
    if (typeof Trust === 'undefined' || !r) return '';
    const t = Trust.score(r);
    return `<span class="trust-chip ${t.color}" title="${UI.esc(t.hint)} — ${UI.esc(t.label)}">${t.emoji} T${t.tier} · ${t.credibility}</span>`;
  }

  // Render the "Research process" transparency panel (planned research only)
  function renderResearchProcess() {
    const panel = $('#researchProcessPanel');
    if (!panel || typeof Planner === 'undefined') return;
    const proc = state.researchProcess;
    if (!proc || !proc.plan) { panel.hidden = true; return; }
    const plan = proc.plan;
    const ev = proc.evidence || {};
    const level = Planner.confidenceLevel(proc.confidence != null ? proc.confidence : 0);
    const queries = [];
    for (const a of (plan.aspects || [])) for (const q of (a.queries || [])) queries.push(q);
    const domains = new Set();
    for (const r of state.results) {
      try { const h = new URL(r.url).hostname; if (h) domains.add(h); } catch { /* ignore */ }
    }
    const lims = (proc.limitations || []).slice(0, 6);

    $('#researchProcessBody').innerHTML = `
      <div class="rp2-grid">
        <div class="rp2-cell"><b>${queries.length}</b><span>Search queries run</span></div>
        <div class="rp2-cell"><b>${domains.size}</b><span>Sources consulted</span></div>
        <div class="rp2-cell"><b class="conf-badge ${level.color}">${level.emoji} ${Math.round((proc.confidence || 0) * 100)}%</b><span>${level.label}</span></div>
        <div class="rp2-cell"><b>${ev.consensusCount || 0}</b><span>Consensus topics</span></div>
        <div class="rp2-cell"><b>${ev.contradictionCount || 0}</b><span>Contradictions</span></div>
      </div>
      ${queries.length ? `<div class="rp2-block"><h5><svg class="ic" aria-hidden="true"><use href="#i-search"/></svg> Searched for</h5><div class="rp2-queries">${queries.map(q => `<span class="rp2-query">${UI.esc(q)}</span>`).join('')}</div></div>` : ''}
      ${ev.clusters && ev.clusters.length ? `<div class="rp2-block"><h5><svg class="ic" aria-hidden="true"><use href="#i-qa"/></svg> Evidence & confidence</h5>${ev.clusters.map(c => {
        const cl = Planner.confidenceLevel(c.confidence);
        return `<div class="rp2-cluster">
          <div class="rp2-cluster-head">
            <span class="rp2-cluster-title">${UI.esc(c.title)}</span>
            <span class="rp2-cluster-meta">${c.count} result${c.count === 1 ? '' : 's'} · ${c.domains} domain${c.domains === 1 ? '' : 's'} · <b class="conf-badge ${cl.color}">${Math.round(c.confidence * 100)}%</b></span>
          </div>
          <div class="rp2-cluster-meta">${c.consensus ? '🟢 multi-source consensus' : c.singleSource ? '🔴 single-source claim' : '🟡 mixed sources'}${c.contradiction ? ` · ⚠️ contradiction detected (${UI.esc(c.contradiction)})` : ''}</div>
        </div>`;
      }).join('')}</div>` : ''}
      ${lims.length ? `<div class="rp2-block"><h5><svg class="ic" aria-hidden="true"><use href="#i-wifi-off"/></svg> Known uncertainties</h5><ul>${lims.map(l => `<li>${UI.esc(l)}</li>`).join('')}</ul></div>` : ''}
    `;
    panel.hidden = false;
  }

  // ═══════════ REPORT GENERATION ═══════════
  async function generateReport(titleOverride, opts = {}) {
    if (state.isGenerating || state.researchRunning) return;
    // Autonomous planning: build a research plan + run parallel searches first
    // when the Deep Research button was used, or the "Deep Research by default"
    // setting is on and no plan has been created yet.
    const wantPlan = opts.plan !== false && (opts.plan === true || state.settings.deepResearch);
    if (wantPlan && !state.activePlan) {
      if (!state.lastQuery) { UI.toast('Search something first', 'info'); return; }
      const done = await runPlannedResearch(state.lastQuery, { merge: state.results.length > 0 });
      if (!done) return; // research superseded by a newer search — drop this generation
    }
    if (!state.results.length) { UI.toast('Search something first', 'info'); return; }

    const customTitle = (typeof titleOverride === 'string' && titleOverride.trim()) ? titleOverride.trim() : null;
    state.isGenerating = true;
    state.reportSavedId = null;
    state.reportMarkdown = '';
    state.reportTitle = customTitle || `Research report: ${state.lastQuery}`;
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
    const planned = !!(state.activePlan && state.activePlan.aspects && state.activePlan.aspects.length);
    const steps = planned
      ? [
          'Research plan ready',
          'Gathering & reading sources',
          'Synthesizing across sources',
          'Writing the report',
          'Finalizing citations',
        ]
      : [
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
    const readStep = planned ? stepEls[1] : stepEls[0];
    if (state.settings.contentReader && state.results.length && typeof Content !== 'undefined') {
      readStep && readStep.classList.add('active');
      readStep && (readStep.lastChild.textContent = 'Reading full articles…');
      const urls = state.results.map(r => r.url).slice(0, 12);
      fullContent = await Content.readArticles(urls);
      if (fullContent && Object.keys(fullContent).length) {
        const n = Object.keys(fullContent).length;
        readStep && (readStep.lastChild.textContent = `Read ${n} full article${n === 1 ? '' : 's'}`);
      } else {
        // backend unavailable — fall back to snippets and say so
        readStep && (readStep.lastChild.textContent = 'Full articles unavailable — using snippets');
      }
    }

    try {
      const { markdown, provider } = await AI.generate(
        state.lastQuery, state.results, state.settings, {
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
        }, ac.signal, fullContent,
        state.activePlan,
        state.researchProcess && state.researchProcess.evidence);

      // final clean render
      state.reportMarkdown = markdown;
      state.reportProvider = provider;
      $('#reportBody').innerHTML = Markdown.render(markdown);
      $('#reportMeta').innerHTML = `
        <span><svg class="ic" aria-hidden="true"><use href="#i-spark"/></svg>${UI.esc(providerLabel(provider))}</span>
        <span><svg class="ic" aria-hidden="true"><use href="#i-clock"/></svg>${UI.fmtDate(Date.now())}</span>
        <span><svg class="ic" aria-hidden="true"><use href="#i-search"/></svg>${UI.esc(state.lastQuery)}</span>
        ${reportStats(markdown)}`;
      if (provider === 'local') {
        UI.toast('AI providers unavailable — generated a smart summary from the sources instead.', 'info', 6000);
      }
      $('#progressFill').style.width = '100%';
      stepEls.forEach(el => { el.classList.add('done'); el.classList.remove('active'); });
      setTimeout(() => { $('#reportProgress').hidden = true; }, 900);

      state.reportSources = state.results.slice(0, 12);
      renderReportSources();
      renderResearchProcess();
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

  // Word count + estimated reading time shown in the report meta
  function reportStats(md) {
    const words = (md || '').trim().split(/\s+/).filter(Boolean).length;
    const mins = Math.max(1, Math.round(words / 200));
    return `<span><svg class="ic" aria-hidden="true"><use href="#i-briefing"/></svg>${words.toLocaleString()} words · ~${mins} min read</span>`;
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
        plan: state.activePlan ? {
          title: state.activePlan.title,
          intent: state.activePlan.intent,
          intentLabel: state.activePlan.intentLabel,
          origin: state.activePlan.origin,
          aspects: (state.activePlan.aspects || []).map(a => ({ question: a.question, queries: a.queries })),
        } : undefined,
        researchProcess: state.researchProcess ? {
          confidence: state.researchProcess.confidence,
          limitations: state.researchProcess.limitations,
          stats: state.researchProcess.stats,
          gaps: state.researchProcess.gaps,
          evidence: state.researchProcess.evidence,
        } : undefined,
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

  async function downloadReport() {
    if (!state.reportMarkdown) return;
    const ok = await UI.confirm(
      'Download report?',
      'Save this report as a <b>.md</b> file to your device? You can also copy it or find it saved in your Library.',
      'Download');
    if (!ok) return;
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
          <span class="lib-foot-actions">
            <button class="listen-btn" data-liblisten="${r.id}" title="Listen to report" aria-label="Listen to report">
              <svg class="ic" aria-hidden="true"><use href="#i-volume"/></svg>Listen
            </button>
            <span class="lib-del" data-del="${r.id}" role="button" aria-label="Delete report" title="Delete">
              <svg class="ic" aria-hidden="true"><use href="#i-trash"/></svg>
            </span>
          </span>
        </div>
      </button>`;
    }).join('') || `<div class="empty-state" style="grid-column:1/-1"><h3>No matches</h3><p>No saved reports match "${UI.esc(filter)}".</p></div>`;

    grid.querySelectorAll('.lib-card').forEach(card => {
      card.addEventListener('click', e => {
        const del = e.target.closest('[data-del]');
        if (del) { e.stopPropagation(); deleteOneReport(del.dataset.del); return; }
        const lib = e.target.closest('[data-liblisten]');
        if (lib) { e.stopPropagation(); listenToLibraryReport(lib.dataset.liblisten); return; }
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

  // Listen to a saved report straight from the Library (no need to open it first)
  async function listenToLibraryReport(id) {
    try {
      const r = await Storage.getReport(id);
      if (!r) { UI.toast('Report not found', 'err'); return; }
      narrateReport(r.markdown, r.title || r.query || 'Saved report');
    } catch { UI.toast('Could not load report to listen to', 'err'); }
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
        <span><svg class="ic" aria-hidden="true"><use href="#i-search"/></svg>${UI.esc(r.query || '')}</span>
        ${reportStats(r.markdown)}`;
      $('#reportBody').innerHTML = Markdown.render(r.markdown);
      $('#reportProgress').hidden = true;
      $('#savedBanner').hidden = true;
      $('#reportSources').hidden = true;
      renderReportSources();
      if (r.plan || r.researchProcess) {
        state.activePlan = r.plan || null;
        state.researchProcess = r.researchProcess ? { ...r.researchProcess, plan: r.plan } : null;
        state.results = (r.sources || []).map(s => ({ title: s.title, url: s.url, source: s.source }));
        renderResearchProcess();
      } else {
        state.activePlan = null;
        state.researchProcess = null;
        const pp = $('#researchProcessPanel');
        if (pp) pp.hidden = true;
      }
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
    const ok = await UI.confirm(
      'Export library?',
      `Save all <b>${reports.length}</b> report${reports.length === 1 ? '' : 's'} as a single JSON file to your device?`,
      'Export');
    if (!ok) return;
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
    refreshNarrationMetrics();
  }

  function refreshNarrationMetrics() {
    if (typeof Anchor === 'undefined') return;
    const m = Anchor.metrics();
    if (!m) {
      ['nmSessions', 'nmCompletion', 'nmAvgTime', 'nmThumbsUp'].forEach(id => {
        const el = $(`#${id}`);
        if (el) el.textContent = '—';
      });
      const mix = $('#nmModeMix');
      if (mix) mix.textContent = 'No listen sessions yet — start listening to see metrics.';
      return;
    }
    const set = (id, val) => { const el = $(`#${id}`); if (el) el.textContent = val; };
    set('nmSessions', m.sessions);
    set('nmCompletion', Math.round(m.completionRate * 100) + '%');
    set('nmAvgTime', m.avgSeconds + 's');
    set('nmThumbsUp', m.thumbsUp);
    const modeCounts = Object.entries(m.modes || {}).map(([k, v]) => `${k}: ${v}`).join(' · ');
    const mix = $('#nmModeMix');
    if (mix) mix.textContent = modeCounts ? `Mode mix: ${modeCounts}` : '';
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
