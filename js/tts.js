/* ─────────────────────────────────────────────
   Aurora — Text-to-Speech engine
   Two engines, one queue:
     • Neural Narrator (free) — Microsoft Edge TTS natural neural voice via
       /api/tts (keyless serverless synthesis, sha1 audio cache). Used when a
       narrator voice is chosen; falls back seamlessly to Web Speech on any failure.
     • Web Speech API — zero keys, zero cost, zero latency (local).
   ───────────────────────────────────────────── */
const TTS = (() => {
  const SETTINGS_KEY = 'aurora-tts';
  const CHUNK_MAX = 200;      // Chrome truncates very long utterances — chunk by sentence
  const NEURAL_CHUNK_MAX = 500; // neural synth is server-round-trip — larger chunks are fine

  let settings = { voice: '', rate: 1, pitch: 1 };

  // ── narrator (free neural voice via serverless /api/tts — Edge TTS) ──
  let narrator = { voice: '' };
  let neuralQueue = [];        // text chunks pending neural synthesis
  let neuralSynth = false;     // pump loop running
  let neuralPaused = false;
  let neuralCancelled = false;
  let neuralEngine = false;    // current track uses the neural engine
  let synthCtrl = null;        // AbortController for in-flight synthesis

  // ── Web Speech state ──
  let queue = [];              // [{ text, ch }] chunks pending (ch = chapter index)
  let playing = false;
  let paused = false;
  let cancelled = false;
  let current = null;          // { title, onStateChange }
  let synth = null;
  let audio = null;            // lazy <audio> element for neural playback

  // ── chapter-aware scripts (anchor briefings) ──
  let scriptChapters = null;   // [{ title, text }]
  let scriptIdx = 0;           // current chapter index
  let onChapter = null;        // fired when the active chapter changes

  function supported() {
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
  }
  function browserFetchAvailable() {
    return typeof window !== 'undefined' && typeof fetch === 'function' && typeof Audio !== 'undefined' && typeof URL !== 'undefined';
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

  // chunk into ≤ max-char sentences (avoid mid-word splits)
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

  // ── voices (Web Speech) ──
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

  // ── narrator config (set from app settings) ──
  function setNarrator(cfg) {
    narrator = { ...narrator, ...(cfg || {}) };
    return narrator;
  }
  function narratorConfig() { return { ...narrator }; }
  // Narrator is usable when a free neural voice is chosen and the browser can fetch audio
  function narratorEnabled() {
    return !!(narrator.voice && browserFetchAvailable());
  }

  // ── Web Speech engine ──
  function speakNext() {
    if (cancelled || paused || !queue.length) {
      if (!queue.length && !paused) finish();
      return;
    }
    const item = queue.shift();
    if (item.ch !== undefined && item.ch !== scriptIdx && onChapter) {
      scriptIdx = item.ch;
      onChapter(scriptIdx);
    }
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

  // ── Neural narrator engine ──
  async function synthChunk(text) {
    if (synthCtrl) synthCtrl.abort();
    synthCtrl = new AbortController();
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: narrator.voice, speed: settings.rate || 1, pitch: settings.pitch || 1 }),
        signal: synthCtrl.signal,
      });
      if (!res.ok) throw new Error(`TTS ${res.status}`);
      const blob = await res.blob();
      if (!blob.size) throw new Error('Empty audio');
      return blob;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw e;
    }
  }

  // Play one synthesized chunk through a reusable <audio> element (awaits 'ended')
  function playAudioBlob(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      if (!audio) audio = new Audio();
      audio.src = url;
      const done = () => { URL.revokeObjectURL(url); audio.removeAttribute('src'); resolve(); };
      audio.onended = done;
      audio.onerror = () => { URL.revokeObjectURL(url); audio.removeAttribute('src'); reject(new Error('Audio playback error')); };
      audio.play().catch(reject);
    });
  }

  // Pump the neural queue: synthesize → play → next, while honoring pause/cancel
  async function pumpNeural() {
    if (neuralSynth) return;
    neuralSynth = true;
    try {
      while (neuralQueue.length && !neuralCancelled) {
        if (neuralPaused) { await new Promise(r => setTimeout(r, 150)); continue; }
        const chunk = neuralQueue.shift();
        if (chunk && chunk.ch !== undefined && chunk.ch !== scriptIdx && onChapter) {
          scriptIdx = chunk.ch;
          onChapter(scriptIdx);
        }
        try {
          const blob = await synthChunk(chunk.text || chunk);
          if (neuralCancelled) continue;
          await playAudioBlob(blob);
        } catch (e) {
          if (e.name === 'AbortError' || neuralCancelled) break;
          // neural path failed (no backend / quota / network) — fall back to Web Speech
          fallbackNeural(chunk.text || chunk);
          break;
        }
      }
    } finally {
      neuralSynth = false;
      if (!neuralCancelled && !neuralPaused && !neuralQueue.length) finishNeural();
    }
  }

  // Mid-stream failure: hand the remaining text to the local engine so nothing is lost
  function fallbackNeural(firstChunk) {
    if (!supported()) { finishNeural(); return; }
    const rest = [firstChunk, ...neuralQueue].join(' ');
    neuralQueue = [];
    scriptChapters = null; // a plain fallback track has no chapter structure
    scriptIdx = 0;
    onChapter = null;
    if (rest.trim()) {
      cancel();
      speakWeb(rest, { title: current ? current.title : '', onStateChange: current ? current.onStateChange : null });
    }
  }

  function finishNeural() {
    neuralCancelled = false;
    const c = current;
    current = null;
    neuralEngine = false;
    if (c && c.onStateChange) c.onStateChange('ended');
  }

  // Public: speak text (prefers narrator when configured, else Web Speech)
  function speak(text, opts = {}) {
    if (narratorEnabled()) return speakNeural(text, opts);
    return speakWeb(text, opts);
  }

  // Neural narrator path
  function speakNeural(text, opts = {}) {
    cancel();
    const chunks = chunkText(text, NEURAL_CHUNK_MAX);
    if (!chunks.length) return false;
    neuralCancelled = false;
    neuralPaused = false;
    neuralEngine = true;
    neuralQueue = chunks;
    current = { title: opts.title || '', onStateChange: opts.onStateChange || null };
    notify('start');
    pumpNeural();
    return true;
  }

  // Web Speech path
  function speakWeb(text, opts = {}) {
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
  function append(text) {
    // the neural engine round-trips to the server per chunk — use its larger
    // chunk size here too so long summaries don't become dozens of tiny calls
    const chunks = chunkText(String(text || ''), neuralEngine ? NEURAL_CHUNK_MAX : CHUNK_MAX);
    if (!chunks.length) return false;
    if (neuralEngine && narratorEnabled()) {
      neuralQueue.push(...chunks.map(t => ({ text: t, ch: scriptIdx })));
      if (!neuralSynth) pumpNeural();
      return true;
    }
    if (!supported() || cancelled) return false;
    queue.push(...chunks.map(t => ({ text: t, ch: scriptIdx })));
    if (!playing && !paused) speakNext();
    return true;
  }

  // ── Chapter-aware scripts (anchor briefings / deep dives) ──
  // Queue tagged chunks so the player can show a live chapter timeline and
  // skip between sections without ever reading an article verbatim.
  function startScript(list, startIdx, opts = {}) {
    if (!list || !list.length) return false;
    const useNeural = narratorEnabled();
    if (!useNeural && !supported()) return false;
    // tag chunks with ABSOLUTE chapter indices so skip/jump keep the timeline honest
    const chunks = [];
    list.forEach((c, i) => {
      const text = String(c && c.text || '').trim();
      if (!text) return;
      chunkText(text, useNeural ? NEURAL_CHUNK_MAX : CHUNK_MAX).forEach(t => chunks.push({ text: t, ch: i + startIdx }));
    });
    if (!chunks.length) return false;

    cancel();
    scriptChapters = list;
    scriptIdx = startIdx;
    onChapter = opts.onChapter || null;

    if (useNeural) {
      neuralCancelled = false;
      neuralPaused = false;
      neuralEngine = true;
      neuralQueue = chunks;
    } else {
      cancelled = false;
      paused = false;
      queue = chunks;
    }
    current = { title: opts.title || '', onStateChange: opts.onStateChange || null };
    notify('start');
    if (useNeural) pumpNeural(); else speakNext();
    if (onChapter) onChapter(startIdx); // announce the first chapter immediately
    return true;
  }

  // Speak a full chaptered script from the top (anchor briefing / deep dive)
  function speakScript(chapters, opts = {}) {
    return startScript(chapters || [], 0, opts);
  }

  // Move to the previous/next chapter of the active script (restarts at its start)
  function skipScript(dir) {
    if (!scriptChapters || !scriptChapters.length) return false;
    const next = Math.min(Math.max(scriptIdx + (dir || 0), 0), scriptChapters.length - 1);
    if (next === scriptIdx) return false;
    const opts = { title: current ? current.title : '', onStateChange: current ? current.onStateChange : null };
    return startScript(scriptChapters, next, { ...opts, onChapter });
  }

  // Jump straight to a chapter by absolute index
  function jumpChapter(idx) {
    if (!scriptChapters || !scriptChapters.length) return false;
    const next = Math.min(Math.max(idx || 0, 0), scriptChapters.length - 1);
    if (next === scriptIdx) return false;
    const opts = { title: current ? current.title : '', onStateChange: current ? current.onStateChange : null };
    return startScript(scriptChapters, next, { ...opts, onChapter });
  }

  function pause() {
    if (neuralEngine) {
      if (neuralPaused) return;
      neuralPaused = true;
      if (audio && !audio.paused) audio.pause();
      notify('paused');
      return;
    }
    if (!supported()) return;
    if (playing && !paused) {
      paused = true;
      try { synth.pause(); } catch { /* ignore */ }
      notify('paused');
    }
  }

  function resume() {
    if (neuralEngine) {
      if (!neuralPaused) return;
      neuralPaused = false;
      if (audio && audio.paused) audio.play().catch(() => {});
      if (!neuralSynth) pumpNeural();
      notify('resumed');
      return;
    }
    if (!supported()) return;
    if (paused) {
      paused = false;
      try { synth.resume(); } catch { /* ignore */ }
      if (!playing) speakNext();
      notify('resumed');
    }
  }

  function cancel() {
    neuralCancelled = true;
    neuralQueue = [];
    neuralPaused = false;
    if (synthCtrl) { try { synthCtrl.abort(); } catch { /* ignore */ } synthCtrl = null; }
    if (audio) { try { audio.pause(); audio.removeAttribute('src'); } catch { /* ignore */ } }
    if (supported()) {
      cancelled = true;
      queue = [];
      playing = false;
      paused = false;
      try { synth.cancel(); } catch { /* ignore */ }
    }
  }

  function stop() {
    cancel();
    finish();
  }

  function state() {
    if (current) return {
      title: current.title,
      playing: neuralEngine ? (neuralQueue.length > 0 || neuralSynth) : playing,
      paused: neuralEngine ? neuralPaused : paused,
      chapter: scriptChapters ? scriptIdx : null,
      chapters: scriptChapters ? scriptChapters.length : 0,
    };
    return null;
  }

  function setSettings(s) {
    settings = { ...settings, ...s };
    saveSettings();
  }

  function init() {
    loadSettings();
    if (!supported()) return false;
    synth = window.speechSynthesis;
    return true;
  }

  return {
    supported, init, speak, speakNeural, speakWeb, append, pause, resume, stop, cancel,
    speakScript, skipScript, jumpChapter,
    voices, defaultVoice, setSettings, getSettings: () => ({ ...settings }),
    setNarrator, narratorConfig, narratorEnabled,
    cleanText, chunkText, state,
  };
})();
