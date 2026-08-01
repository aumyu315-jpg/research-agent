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
    elevenKey: '',                 // ElevenLabs key — enables the cloned narrator voice
    narratorModel: 'eleven_turbo_v2_5',
    narratorVoiceId: '',           // cloned voice id (created via /api/tts/voice)
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
    narratorBusy: false,   // voice cloning in progress
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
    $('#elevenKey').value = state.settings.elevenKey || '';
    $('#narratorModel').value = state.settings.narratorModel || 'eleven_turbo_v2_5';
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
    $('#elevenKey').addEventListener('change', e => {
      state.settings.elevenKey = e.target.value.trim();
      saveSettings();
      syncNarrator();
    });
    $('#narratorModel').addEventListener('change', e => {
      state.settings.narratorModel = e.target.value.trim() || 'eleven_turbo_v2_5';
      saveSettings();
      syncNarrator();
    });
    $('#cloneVoiceBtn').addEventListener('click', cloneNarratorVoice);
    $('#testNarratorBtn').addEventListener('click', testNarrator);
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
    if ('speechSynthesis' in window) {
      window.speechSynthesis.onvoiceschanged = populateTtsVoices;
    }
  }

  // ═══════════ TEXT-TO-SPEECH ═══════════
  function initTts() {
    if (!TTS.supported() && !state.settings.elevenKey) return;
    TTS.init();
    const rate = TTS.getSettings().rate || 1;
    $('#ttsRate').value = String(rate);
    populateTtsVoices();
    syncNarrator();
  }

  // Pass the narrator config to the TTS engine + refresh the settings status line
  function syncNarrator() {
    if (typeof TTS === 'undefined') return;
    TTS.setNarrator({
      key: state.settings.elevenKey || '',
      voiceId: state.settings.narratorVoiceId || '',
      model: state.settings.narratorModel || 'eleven_turbo_v2_5',
    });
    refreshNarratorStatus();
  }

  // Status hint in Settings: narrator ready / needs key / needs clone / browser voices
  function refreshNarratorStatus() {
    const el = $('#narratorStatus');
    if (!el || typeof TTS === 'undefined') return;
    const hasKey = !!state.settings.elevenKey;
    const hasVoice = !!state.settings.narratorVoiceId;
    if (!hasKey) {
      el.textContent = 'Narrator: add an ElevenLabs key to clone the bundled narrator voice — otherwise Aurora uses your browser\'s voices (free).';
      return;
    }
    if (!hasVoice) {
      el.textContent = 'Narrator: key set ✓ — click “Clone narrator” once to create your voice (server needs ELEVENLABS_API_KEY set on Netlify for the actual cloning).';
      return;
    }
    el.textContent = 'Narrator: ready ✓ — Aurora reads news & reports in your cloned voice. Click “Test voice” to hear it.';
  }

  // Clone the bundled narrator sample (assets/narrator-voice.m4a) via /api/tts/voice
  async function cloneNarratorVoice() {
    const key = (state.settings.elevenKey || '').trim();
    if (!key) { UI.toast('Add your ElevenLabs API key first (Settings → Narrator voice).', 'info', 4500); return; }
    if (state.narratorBusy) return;
    state.narratorBusy = true;
    UI.setLoading($('#cloneVoiceBtn'), true, 'Cloning…');
    try {
      const res = await fetch('assets/narrator-voice.m4a');
      if (!res.ok) throw new Error('Could not load the narrator sample');
      const buf = await res.arrayBuffer();
      const base64 = arrayBufferToBase64(buf);
      const resp = await fetch('/api/tts/voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Aurora Narrator', audio: base64, mime: 'audio/mp4' }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.voice_id) throw new Error((data.error || 'Cloning failed — is the backend deployed?'));
      state.settings.narratorVoiceId = data.voice_id;
      saveSettings();
      syncNarrator();
      UI.toast('Narrator voice cloned ✓', 'ok', 4000);
    } catch (e) {
      UI.toast(e.message || 'Voice cloning failed.', 'err', 5000);
    } finally {
      state.narratorBusy = false;
      UI.setLoading($('#cloneVoiceBtn'), false);
    }
  }

  // Speak a short sample so users can compare narrator vs browser voice
  function testNarrator() {
    if (typeof TTS === 'undefined') return;
    const sample = 'Hello, I\'m Aurora, your research narrator. I can read news and reports aloud in my own voice.';
    const ok = TTS.speak(sample, { title: 'Narrator test' });
    if (!ok) UI.toast('Nothing to play — TTS unavailable in this browser.', 'info');
    showTtsPlayer('Narrator test');
  }

  function arrayBufferToBase64(buf) {
    let bin = '';
    const bytes = new Uint8Array(buf);
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
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
    // voice dropdown is meaningless while the cloned narrator is active
    const voiceSel = $('#ttsVoice');
    if (voiceSel) {
      voiceSel.disabled = isNarrator;
      voiceSel.title = isNarrator ? 'The cloned narrator voice is used while active' : '';
    }
  }

  function hideTtsPlayer() {
    $('#ttsPlayer').hidden = true;
    $$('[data-listen].playing').forEach(b => b.classList.remove('playing'));
  }

  function speakTrack(text, title, onStateChange) {
    if (!TTS.supported()) { UI.toast('Audio isn\'t supported in this browser.', 'err'); return; }
    state.ttsTrack = { text, title };
    showTtsPlayer(title);
    // hide the player + clear the highlight when the queue drains naturally
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

  function restartTtsTrack() {
    if (!state.ttsTrack || !TTS.state()) return;
    // re-speak from the top with the new voice/rate
    const { text, title } = state.ttsTrack;
    speakTrack(text, title);
  }

  function toggleTtsPause() {
    const st = TTS.state();
    if (!st) return;
    if (st.paused) { TTS.resume(); $('#ttsPlayer').classList.remove('paused'); }
    else { TTS.pause(); $('#ttsPlayer').classList.add('paused'); }
  }

  function stopTts() {
    TTS.stop();
    hideTtsPlayer();
    state.ttsTrack = null;
  }

  // News story: speak headline + snippet instantly, then append full article text
  async function listenToNews(story, btn) {
    const headline = `${story.title || ''}. ${story.snippet || ''}`;
    const title = story.title || 'News story';
    speakTrack(headline, title);
    markListening(btn);
    // Phase 2: seamlessly append full article text via the serverless reader
    try {
      if (story.url && typeof Content !== 'undefined' && state.settings.contentReader !== false) {
        const texts = await Content.readArticles([story.url]);
        const full = texts && texts[story.url];
        // append when idle (headline already finished) or while this same track plays;
        // avoid contaminating a different track if the user switched stories mid-fetch
        if (full && (!TTS.state() || TTS.state().title === title)) TTS.append(` ${full}`);
      }
    } catch { /* audio stays with headline+snippet */ }
  }

  // Research result: speak title + snippet
  function listenToResult(r, btn) {
    const text = `${r.title || ''}. ${r.snippet || ''}`;
    speakTrack(text, r.title || 'Search result');
    markListening(btn);
  }

  // AI report: speak the full markdown (cleaned) — Aurora-authored, no licensing issue
  function listenToReport() {
    if (!state.reportMarkdown) { UI.toast('No report to listen to yet.', 'info'); return; }
    speakTrack(state.reportMarkdown, state.reportTitle || 'Research report');
  }

  function markListening(btn) {
    $$('[data-listen].playing').forEach(b => b.classList.remove('playing'));
    if (btn) btn.classList.add('playing');
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
    generateReport(`AI News Summary — ${scope}`);
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

  // ═══════════ REPORT GENERATION ═══════════
  async function generateReport(titleOverride) {
    if (state.isGenerating) return;
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
        if (e.target.closest('[data-listen]')) { e.stopPropagation(); return; }
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
