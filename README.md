# ⚡ Aurora — AI Research Studio

Search the web across **news, articles, papers & reference sources**, then get a beautifully organized **AI research report** — all free, no API keys required by default.

![stack](https://img.shields.io/badge/stack-vanilla%20JS%20%2F%20CSS%20%2F%20HTML-blueviolet)
![ai](https://img.shields.io/badge/AI-pollinations.ai%20free%20%2B%20optional%20Gemini-22d3ee)

## ✨ Features

- 🔎 **10-source live search** — Wikipedia, Hacker News, **keyless web search (SearXNG → DuckDuckGo, optional Brave)**, OpenAlex + Crossref academic papers, Wikinews + (optional) GNews news, **OpenLibrary books**, **Stack Overflow Q&A**, **GitHub code & repos**, **CoinGecko live market prices**, and **Open-Meteo live weather**. Every source verified CORS-enabled & free (no keys needed for most).
- 📰 **Live News mode** — a full daily-news section with **34 countries**, six categories (Top, World, Tech, Business, Science, Sports), topic search, a live **markets & weather ticker**, and an **AI chat** panel for follow-up questions. The **AI Summary** button turns the current feed into a full AI research report.
- 🎧 **Listen (TTS)** — every news card, search result and AI report can be **read aloud** in your browser (Web Speech API — zero keys, zero cost). For news & results, Listen **scrapes the full article from the publisher's site, writes an elegant AI summary, and narrates that** — a complete, polished briefing instead of raw scraped text (falls back gracefully if the backend is down). The persistent player bar offers voice + speed controls. See `TTS-STRATEGY.md`.
- 🗣️ **News Anchor narration** — Aurora presents every story like a professional news anchor (never raw TTS): content intelligence strips adverts & boilerplate, story-type tone adaptation (breaking/politics/finance/tech/science…), a **Briefing (~60–120s) vs Deep Dive** toggle, dynamic transitions, a pronunciation dictionary (NVIDIA, TSMC, Bhubaneswar…), and **chaptered scripts** with a live section timeline + skip in the player, plus 👍/👎 feedback. Popular articles pre-warm so they play instantly. See `TTS-STRATEGY.md` §8.
- 🗣️ **Free neural narrator** — pick a natural neural voice (Microsoft Edge TTS, keyless & free) and Aurora reads news, articles & reports aloud through the serverless `/api/tts` endpoint (sha1 audio caching). Falls back to your browser's voices automatically if the backend is unreachable.
- 🧠 **Autonomous Research Planner** — the *Deep Research* button turns any question into a planned investigation: intent classification (informational / comparative / temporal / navigational / transactional / research), sub-question decomposition (AI-first, heuristic fallback), **parallel searches across plan aspects**, knowledge-gap detection with targeted second-round searches, and cross-source evidence scoring (consensus / single-source claims / contradictions → confidence %). Every report includes a **Research Process** panel (queries run, sources consulted, confidence, known uncertainties) and each source shows a **trust tier** chip (🟢 T1 authority → 🔴 T4 user content). Enable **Deep Research by default** for AI reports in Settings.
- 🤖 **Free AI reports** — automatic provider fallback chain: keyless **Pollinations.ai** → optional **Google Gemini**, **Groq** (generous free tier, blazing-fast Llama) or **OpenRouter** free models → guaranteed local smart-summary (works even fully offline). Comprehensive **1200–2000 word** executive-grade reports built from full article text (up to 12 articles read server-side), with source discipline and quantified analysis.
- 📄 **Beautiful markdown reports** — streaming generation with live progress steps, inline `[n]` citations, key findings, analysis & sources.
- 💾 **Offline library** — every report is auto-saved to IndexedDB. Browse, search, open, export or delete reports **even without internet**.
- 📱 **PWA** — installable, works offline via service worker, fully responsive from phone to desktop.
- ⚙️ **Settings** — choose AI provider, add optional keys, toggle sources, adjust result counts. Keys stay in your browser (localStorage).

## 🚀 Run locally

Any static file server works:

```bash
# Python
python -m http.server 8080

# or Node
npx serve .
```

Then open `http://localhost:8080`.

> ⚠️ IndexedDB & service workers require a real `http(s)` origin — don't just double-click `index.html`.

### With the serverless backend (recommended)

The `netlify/functions/aurora.js` function adds **full-article reading** (RAG-style reports) — Aurora fetches the actual text of top articles instead of just snippets. To run it locally:

```bash
npm install
npm run dev   # starts Netlify Dev with functions + static site
```

Or run the static server and the function separately via the Netlify CLI.

## ☁️ Deploy (free, no API keys needed on your side)

### 1. Netlify — full features (functions need a real site)
Netlify Drop deploys the static site but **not the serverless function**. For full-content reading, use the CLI/git flow:

```bash
npm install
npx netlify login
npx netlify deploy --prod --dir .
```

1. Or push this folder to a GitHub repo and import it at [app.netlify.com](https://app.netlify.com) — Netlify auto-detects the function.
2. Add any secrets in **Site settings → Environment variables**: `BRAVE_API_KEY` (optional — improves web search quality; without it, the serverless function uses **keyless SearXNG instances → DuckDuckGo** automatically).
3. Live at `https://…netlify.app` — `/api/*` routes to the function.

**Netlify Drop (no account, static only):** go to [app.netlify.com/drop](https://app.netlify.com/drop), drag the folder in. Works fully except full-article reading (Aurora falls back to snippets automatically).

### 2. Vercel — Git-connected
1. Push this folder to a GitHub/GitLab repo
2. New Project → Import → **Framework: Other** → Deploy
3. Live at `https://…vercel.app`

### 3. GitHub Pages
1. Push to a repo
2. Settings → Pages → Deploy from branch `main` → root
3. Live at `https://<user>.github.io/<repo>/`

## 🔑 Optional keys (Settings → gear icon)

| Key | Where | Why |
|---|---|---|
| Gemini API key | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | Premium reports (free tier) |
| Groq API key | [console.groq.com/keys](https://console.groq.com/keys) | Fast Llama models, very generous free tier |
| OpenRouter key | [openrouter.ai/keys](https://openrouter.ai/keys) | Free `:free` models (reliable fallback) |
| GNews API key | [gnews.io](https://gnews.io) | Extra live news source (free tier, 100 req/day) — Wikinews needs no key |

**No server-side env vars are required** — the free neural narrator uses Microsoft Edge TTS (keyless), and web search falls back to keyless SearXNG → DuckDuckGo automatically.

**Without any keys** Aurora still works: it uses keyless Pollinations, and if that's rate-limited or offline, it falls back to a local smart summary built directly from the search results — so the Generate button always produces a report.

**Provider preference:** when a Gemini or OpenRouter key is configured, it's preferred over keyless Pollinations automatically (better-quality reports). Set your default in Settings.

## 🧠 Architecture

```
index.html              Single-page shell (news + research + results + report + library views, settings modal, SVG sprite, TTS player)
css/styles.css          Design system — dark glass UI, aurora gradients
js/ui.js                DOM helpers, toasts, debounce, copy/download
js/markdown.js          Dependency-free Markdown renderer (HTML-escaped)
js/storage.js           IndexedDB report store + localStorage settings
js/search.js            10-source search engine + live news (countries, categories, ticker) — CORS-verified
js/content.js           Client for the serverless full-content reader
js/ai.js                AI providers: Pollinations, Gemini, Groq, OpenRouter + local fallback
js/trust.js             Source trust tiers (T1–T4) + credibility scoring
js/planner.js           Autonomous research planner: intent, plan, parallel search, gaps, evidence
js/tts.js               Text-to-speech engine: Web Speech API + free neural narrator (Edge TTS via /api/tts) + chaptered script queue
js/anchor.js            Anchor narration engine: content intelligence, story-type detection, pronunciation, narrative construction, feedback/store, AI-assisted scripts
js/fx.js                Ambient FX canvas — constellation/particle background
test-tts.js             TTS chunking, sanitization & narrator-config unit tests
test-anchor.js          Anchor narration unit tests (29 tests)
js/app.js               App controller — routing, search, news, chat, report gen, library, TTS wiring
netlify/functions/aurora.js   Serverless: article fetcher/extractor + keyless web search (SearXNG → DDG, optional Brave) + RSS news feeds + free Edge TTS narrator
netlify.toml            Functions routing (/api/*)
sw.js / manifest        PWA offline support
test-markdown.js        Markdown renderer unit tests
test-content.js         Article extractor unit tests
test-ai.js              AI prompt & synthesis unit tests
test-search.js          Search engine & type-detection unit tests
test-planner.js         Research planner + trust-tier unit tests
```

## 📋 Notes

- Reports are stored only in **your browser** (IndexedDB) — private by default.
- The AI synthesizes from the actual search results returned (up to 30 fed to the model, with full article text for the top ~12), so citations map to real sources.
- Pollinations' anonymous tier is rate-limited (1 concurrent request/IP); the app retries, then falls through to keyed providers, then to a local summary — and always shows a friendly note about which provider produced the report.
- The serverless function keeps keys server-side: `BRAVE_API_KEY` (if set) proxies Brave search through `/api/search`; without a key it falls back to **keyless SearXNG public instances (parallel, first-wins) then DuckDuckGo HTML**. Article fetching happens on the server (no CORS issues, results cached 10 min). It also aggregates **RSS news feeds** (`/api/news`) for the live News mode and serves the **free neural narrator** (`/api/tts`, Edge TTS — keyless, audio cached 24h).
- **TTS is 100% free**: browser voices are generated locally and never stored; the optional neural narrator uses free keyless Microsoft Edge TTS through `/api/tts`. Full licensing rationale in `TTS-STRATEGY.md`.
