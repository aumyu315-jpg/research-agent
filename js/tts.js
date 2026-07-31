/* ─────────────────────────────────────────────
   Aurora — Text-to-Speech engine (Web Speech API)
   Zero keys · zero cost · zero latency (local)
   Phase 1: headline/snippet narration
   Phase 2: full-article narration (seamless append)
   ───────────────────────────────────────────── */
const TTS = (() => {
  const SETTINGS_KEY = 'aurora-tts';
  const CHUNK_MAX = 200; // Chrome truncates very long utterances — chunk by sentence

  let settings = { voice: '', rate: 1, pitch: 1 };
  let queue = [];         // [{ text, markdown }] chunks pending
  let playing = false;
  let paused = false;
  let cancelled = false;
  let current = null;     // { title, onStateChange }
  let synth = null;

  function supported() {
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
  }

  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      settings = { ...settings, ...s };
    } catch { /* ignore */ }
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
  }

  // ── text preparation (pure, testable) ──
  function cleanText(src) {
    return String(src || '')
      // remove markdown links -> keep label
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      // remove image/audio markdown
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      // remove code fences & inline code backticks
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]*)`/g, '$1')
      // strip markdown emphasis / highlight / headers / hr
      .replace(/(^|\s)(#{1,6})\s+/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/_([^_]+)_/g, '$1')
      .replace(/==([^=]+)==/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/(^|\s)[-*+]\s+/g, '$1')
      .replace(/^\s*(?:>\s?)+/gm, '')
      // table pipes -> comma separation
      .replace(/\|/g, ', ')
      // strip separators left dangling at the edges (e.g. after pipe conversion)
      .replace(/^[\s,;:]+|[\s,;:]+$/g, '')
      // normalize comma spacing so pipes don't leave 'A , B'
      .replace(/\s*,\s*/g, ', ')
      // citation markers like [1], [12]
      .replace(/\[\d+\]/g, ' ')
      // URLs
      .replace(/https?:\/\/\S+/g, ' ')
      // collapse whitespace
      .replace(/\s+/g, ' ')
      .trim();
  }

  // chunk into ≤ CHUNK_MAX-char sentences (avoid mid-word splits)
  function chunkText(text, max = CHUNK_MAX) {
    const clean = cleanText(text);
    if (!clean) return [];
    const sentences = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [clean];
    const chunks = [];
    let cur = '';
    for (const s of sentences) {
      if ((cur + ' ' + s).trim().length <= max) {
        cur = (cur + ' ' + s).trim();
      } else {
        if (cur) chunks.push(cur);
        // a single sentence longer than max — hard-split by words
        if (s.length > max) {
          let rest = s;
          while (rest.length > max) {
            let cut = rest.lastIndexOf(' ', max);
            if (cut < max * 0.5) cut = max;
            chunks.push(rest.slice(0, cut).trim());
            rest = rest.slice(cut).trim();
          }
          cur = rest;
        } else {
          cur = s.trim();
        }
      }
    }
    if (cur) chunks.push(cur);
    return chunks;
  }

  // ── voices ──
  function voices() {
    if (!supported()) return [];
    try { return synth.getVoices() || []; } catch { return []; }
  }

  function defaultVoice() {
    const list = voices();
    if (!list.length) return null;
    // exact persisted match
    if (settings.voice) {
      const saved = list.find(v => v.name === settings.voice);
      if (saved) return saved;
    }
    // prefer natural English voices, then any English, then first
    const pref = ['Google US English', 'Google UK English Female', 'Microsoft Aria Online (Natural)', 'Samantha', 'Microsoft Zira'];
    for (const n of pref) {
      const v = list.find(x => x.name === n);
      if (v) return v;
    }
    return list.find(v => /^en/i.test(v.lang)) || list[0] || null;
  }

  // ── engine ──
  function speakNext() {
    if (cancelled || paused || !queue.length) {
      if (!queue.length && !paused) finish();
      return;
    }
    const item = queue.shift();
    const utter = new SpeechSynthesisUtterance(item.text);
    const v = defaultVoice();
    if (v) { utter.voice = v; utter.lang = v.lang || 'en-US'; }
    utter.rate = settings.rate || 1;
    utter.pitch = settings.pitch || 1;
    utter.onend = () => { playing = false; speakNext(); };
    utter.onerror = () => { playing = false; speakNext(); };
    playing = true;
    synth.speak(utter);
  }

  function finish() {
    playing = false;
    const c = current;
    current = null;
    if (c && c.onStateChange) c.onStateChange('ended');
  }

  function notify(mode) {
    if (current && current.onStateChange) current.onStateChange(mode);
  }

  // Public: speak text (replaces any active playback)
  function speak(text, opts = {}) {
    if (!supported()) return false;
    cancel();
    const chunks = chunkText(opts.raw !== false ? text : String(text || ''));
    if (!chunks.length) return false;
    cancelled = false;
    paused = false;
    queue = chunks.map(t => ({ text: t }));
    current = { title: opts.title || '', onStateChange: opts.onStateChange || null };
    speakNext();
    notify('start');
    return true;
  }

  // Public: append more text to the current queue (full-article narration)
  // Note: allowed even when idle — a late full-text fetch should still start narration.
  function append(text) {
    if (!supported() || cancelled) return false;
    const chunks = chunkText(String(text || ''));
    if (!chunks.length) return false;
    queue.push(...chunks.map(t => ({ text: t })));
    if (!playing && !paused) speakNext();
    return true;
  }

  function pause() {
    if (!supported()) return;
    if (playing && !paused) {
      paused = true;
      try { synth.pause(); } catch { /* ignore */ }
      notify('paused');
    }
  }

  function resume() {
    if (!supported()) return;
    if (paused) {
      paused = false;
      try { synth.resume(); } catch { /* ignore */ }
      if (!playing) speakNext();
      notify('resumed');
    }
  }

  function cancel() {
    if (!supported()) return;
    cancelled = true;
    queue = [];
    playing = false;
    paused = false;
    try { synth.cancel(); } catch { /* ignore */ }
  }

  function stop() {
    cancel();
    finish();
  }

  function state() {
    return current ? { title: current.title, playing, paused } : null;
  }

  function setSettings(s) {
    settings = { ...settings, ...s };
    saveSettings();
  }

  function init() {
    if (!supported()) return false;
    synth = window.speechSynthesis;
    loadSettings();
    return true;
  }

  return {
    supported, init, speak, append, pause, resume, stop, cancel,
    voices, defaultVoice, setSettings, getSettings: () => ({ ...settings }),
    cleanText, chunkText, state,
  };
})();
