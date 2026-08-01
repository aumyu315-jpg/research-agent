# Aurora — Text-to-Speech (TTS) Voiceover Implementation Strategy

**Goal:** Let users listen to news articles and reports directly on Aurora, without visiting the publisher site.
**Constraint (project decision):** free-first — every implemented phase must be **completely free** or use a **generous free tier** (~0.5–1M chars/mo or keyless).

---

## 1. TTS API / Service Evaluation

| Option | Voice quality | Languages | Free tier | Paid (per 1M chars) | Rate limits | Latency | Verdict |
|---|---|---|---|---|---|---|---|
| **Web Speech API** (`speechSynthesis`) | Good — OS/browser dependent (Google voices on Chrome, Apple voices on Safari, robotic on some Linux) | Matches OS voices (~40–200 voices) | **100% free, zero keys, zero infra** | — | None (local) | **Near-zero (local)** | ✅ **Phase 1 & 2 engine — implemented now** |
| **Google Cloud TTS** (Neural2/WaveNet) | Excellent — natural prosody | 75+ langs, 380+ voices | **1M chars/mo** (Neural2/WaveNet) | $16 (neural) / $4 (standard) | generous, adjustable quotas | ~300–800ms | ⚪ Phase 3 (keyed, optional) |
| **Amazon Polly** | Very good (neural) | 30+ langs | **1M neural chars/mo** (12 mo trial), 5M standard | $16 (neural) / $4 (standard) | 1 concurrent on free tier | ~400–900ms | ⚪ Phase 3 (keyed, optional) |
| **Microsoft Azure Speech** | Excellent | 100+ langs | **0.5M chars/mo** (F0, permanent) | ~$16 neural | 1 concurrent (F0) | ~300–700ms | ⚪ Phase 3 (keyed, optional) |
| **ElevenLabs** | State-of-the-art | 29+ langs | ~10K credits (~10 min) / mo | high | strict | ~500–1200ms | ❌ free tier too small for news |
| **Open-source (Piper / Coqui XTTS)** | Good–excellent | 30+ / 20+ langs | **Free, self-hosted** | infra only | none | ~200–500ms (GPU) | 🔵 Advanced/offline phase (heavy ops) |

### Recommendation
- **Implement the Web Speech API now.** It is the only option that is *completely free, keyless, and zero-latency* — ideal for the "headline → audio in < 300ms" UX goal. Quality is good on modern Chrome/Safari/Edge.
- **Architect for a provider switch** (see §4). If voice quality becomes a differentiator, add a Phase 3 serverless neural-TTS endpoint (Google/Azure free tiers) with graceful fallback: neural voice when a key is configured, Web Speech otherwise. Never block playback on a keyed service.

---

## 2. Content Extraction & Audio Generation Architecture

### 2.1 Content pipeline (already exists in Aurora — reuse!)
- News cards already carry `title` + `snippet` + `url` + `publishedAt` + `location`.
- The serverless function (`/api/content`) already extracts **full article text** from URLs (stripTags, main-article detection, 8K chars, 10-min memory cache).
- **Phase 2 (full article narration) therefore costs zero new infrastructure:** `listen(story)` speaks the headline+snippet immediately, then fetches `/api/content` and **appends** the full text to the queue seamlessly.

### 2.2 Audio generation at scale — two models
1. **Client-side TTS (Phases 1–2, implemented):** no audio files are generated or stored; `speechSynthesis` speaks text directly in the browser. Zero storage, zero bandwidth, perfect privacy, scales infinitely. Downside: voice depends on the user's OS/browser.
2. **Server-side neural TTS (Phase 3, optional):**
   - Serverless endpoint `/api/tts?text=…` (or POST) → provider SDK → returns audio bytes (mp3/ogg).
   - **Cache key = sha1 of the text** (e.g., 30–120 chars → cache hit rate is high for popular stories). Cache in the function's in-memory Map (small) + optionally Netlify Blobs / an object store for a day-level TTL; serve via the CDN edge.
   - Rate-limit generously (e.g., 60 req/min per user) to stay inside free tiers; a 1000-char article ≈ 3–5s of neural audio ≈ well under 1M chars/mo for typical use.

### 2.3 Latency budget (headline → audio)
| Step | Phase 1 (headline+snippet) | Phase 2 (full article) |
|---|---|---|
| Click Listen | 0ms | 0ms |
| Speak headline+snippet | **< 100ms** (local) | **< 100ms** |
| Fetch full text (`/api/content`, cached) | — | ~300–1500ms (hidden) |
| Append full narration | — | seamless queue append |

**Key latency wins (implemented):**
- Speak the *snippet instantly*, then append full text when it arrives (no spinner, no blank audio).
- Persist voice + rate prefs so no config step before playback.
- `speechSynthesis.cancel()` before each new play → instant track switching.
- Chrome long-utterance bug → **chunk text by sentence** (~200 chars) and queue chunks.

---

## 3. User Experience & Accessibility Design

### 3.1 Playback controls (implemented)
- **Listen button (🎧/🔊)** on every news card, search result, and report — icon + label, always visible.
- **Persistent mini player bar** (fixed bottom): now-playing title, pause/resume, stop, **voice selector**, **speed selector (0.75×–2×)**, close.
- **Single global queue**: clicking a new Listen replaces the current track instantly (no overlapping voices).
- Feedback: animated equalizer bars while speaking; the active card is visually marked; toast on error.

### 3.2 Voice selection
- Populate from `speechSynthesis.getVoices()` — show "name (language)" in the dropdown.
- Default: pick the best natural English voice (Google US English → Samantha → system default).
- Persist selection + rate in localStorage; apply to all subsequent playback.

### 3.3 Accessibility (WCAG 2.1 AA)
- All controls are native `<button>`/`<select>` with `aria-label`s; fully keyboard operable.
- The player is a `role="region"` with `aria-live="polite"` "now playing" text for screen readers.
- Text content is read in reading order; no autoplay (user-initiated only — respects reduced-motion and autoplay policies).
- Speech output complements (never replaces) visual text; focus remains on the button after activation.
- `prefers-reduced-motion`: equalizer animation disabled (global media query already handles animations).

---

## 4. Licensing / Terms-of-Service Implications

**This is the highest-risk area. Read carefully.**

- **RSS feeds**: Fetching headlines/snippets via RSS is normal aggregation practice (BBC/Guardian/Google News RSS). *Narration is a new derivative use.*
- **Full-text reproduction**: Reading an article and **speaking it aloud in full** is a form of redistribution. Many publishers' terms prohibit systematic caching/re-publication of full content. Mitigations:
  1. **Never persist audio files or full text** for redistribution (implemented: audio is generated locally and discarded; full text is fetched on demand with a short cache, never stored in the library).
  2. **Show attribution + link** on every card (already done — outlet + Read link) and announce "Reported by [Outlet]" in the narration so authorship is clear.
  3. **No download/export of narrated audio** in free phases — listening only. This keeps it in the "personal use / assistive access" bucket.
  4. **Honor robots.txt** and publisher terms where practical; respect `noindex`/paywalled pages (the content extractor already fails gracefully on paywalls).
  5. **Fair-use positioning**: reading *headline + snippet* (Phase 1) is very safe; full-article narration is a gray area — prefer it only for:
     - outlets whose RSS explicitly permits syndication/reuse (e.g., many open/free outlets),
     - the user's own **AI-generated research reports** (Aurora-authored content — zero licensing issue, this is the flagship "listen to your report" feature),
     - articles where the extractor returns only partial text.
  6. **Display a small note** ("Audio is generated in your browser; not affiliated with the publisher") in the player.

**Recommended policy:** Listen = ephemeral, attributed, on-demand. Never a podcast feed of others' articles, never downloadable audio of third-party content. Full license for *Aurora-generated* content only.

---

## 5. Implementation Complexity (intermediate team)

| Task | Est. effort | Risk |
|---|---|---|
| Web Speech engine wrapper (`js/tts.js`) | ½–1 day | Low |
| Chunking + queue + append | ½ day | Med (Chrome utterance limits) |
| Player bar UI + voice/rate + a11y | 1 day | Low |
| Card/report listen wiring | ½ day | Low |
| Full-article append via `/api/content` | ½ day | Low |
| Tests (chunking, sanitize, settings) | ½ day | Low |
| **Phase 3** serverless neural endpoint + cache | 2–3 days | Med (keys, quotas) |
| **Total (Phases 1–2, done here)** | **~4 days** | Low |

---

## 6. Phased Rollout

- **Phase 1 — Headline summaries (SHIPPED):** Listen button on news cards + search results → speaks headline + snippet locally. Zero keys, zero cost, < 100ms latency. Voice + speed selection, persistent player, full a11y.
- **Phase 2 — Full article narration (SHIPPED):** After the snippet, seamlessly appends the full article text fetched through the existing `/api/content` backend. Also enables **"Listen to this report"** for AI research reports (fully Aurora-owned content).
- **Phase 3 — Cloned narrator voice (SHIPPED):** `/api/tts` + `/api/tts/voice` serverless endpoints (ElevenLabs), instant voice cloning of the bundled `assets/narrator-voice.m4a` sample, sha1 audio caching (24h), Settings UI (key + clone + test), graceful Web Speech fallback whenever no key is set or the backend is unavailable. Voice engine preference lives in `js/tts.js` (`setNarrator` / `narratorEnabled`).

---

## 7. Files Touched (this change)
- `js/tts.js` — engine: Web Speech (voices, chunking, queue) + neural narrator (`/api/tts`, pause/resume/cancel, fallback).
- `index.html` — sprite icons, listen buttons, player bar, report listen, narrator settings group, FX canvas.
- `css/styles.css` — player bar, listen buttons, equalizer, narrator settings, futuristic glass hero stage.
- `js/app.js` — wiring: cards, results, report, player controls, narrator clone/test, FX init.
- `netlify/functions/aurora.js` — `/api/tts`, `/api/tts/voice`, `/api/tts/status` (ElevenLabs, cached).
- `js/fx.js` (new) — ambient constellation canvas background.
- `assets/narrator-voice.m4a` (new) — bundled narrator voice sample.
- `sw.js`, `README.md`, `package.json`, `test-tts.js`, `test-content.js` — cache, docs, tests.
