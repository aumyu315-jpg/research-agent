/* ─────────────────────────────────────────────
   Aurora — AI report generation
   Provider fallback chain (first success wins):
   1. Selected provider (pollinations keyless / gemini / openrouter)
   2. Any other configured keyed provider
   3. Local template synthesis — ALWAYS succeeds, works offline
   ───────────────────────────────────────────── */
const AI = (() => {
  const PROGRESS = {
    preparing: 'Preparing sources',
    synthesizing: 'Synthesizing across sources',
    writing: 'Writing the report',
    finalizing: 'Finalizing & citing',
  };

  const CHAT_SYSTEM = `You are Aurora, a brilliant, approachable AI assistant embedded in a news & research studio.
You help users understand any topic in depth — news events, science, history, technology, markets, and more.

# GUIDELINES:
- Answer directly and conversationally. No preamble like "Sure!" or "Great question!".
- Be accurate; if uncertain, say so honestly and give the user a way to verify.
- Use **bold** for key terms and ==double equals== to highlight dates, numbers, or the single most important fact.
- Keep answers focused but complete — go deeper when the user asks to.
- Use markdown: bullets, short lists, and occasional bold. Avoid giant walls of text.
- If the user references "the news" or "today's stories", you may not have their exact feed — answer from general knowledge and suggest they run a search or AI summary for live specifics.`;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ── Prompt ──
  function buildPrompt(query, results, fullContent) {
    const packed = results.slice(0, 20).map((r, i) => {
      const article = fullContent && fullContent[r.url];
      const body = article
        ? `    [FULL TEXT READ]\n${article.slice(0, 1500)}`
        : `    ${(r.snippet || '').slice(0, 200)}`;
      return `[${i + 1}] (${r.source}) ${r.title}\n    URL: ${r.url}\n${body}`;
    }).join('\n\n');
    const readNote = fullContent
      ? '\n\nFull article text is provided for several sources — read it carefully and base your analysis on it.'
      : '';
    const today = new Date().toISOString().slice(0, 10);

    return {
      system: `You are Aurora, an elite professional research analyst delivering an executive-grade intelligence brief. Your reports are used for decision-making, so precision, source discipline and analytical rigor are non-negotiable.

# REPORT STRUCTURE (use all that apply, in this order):
## Executive Summary — a tight 3–6 sentence verdict with the key numbers.
## Key Facts at a Glance — 5–10 bullet points, each quantified where possible.
## Background & Context — what this topic is and why it matters now.
## Current Landscape — recent developments, latest data, key players (cite [n]).
## Detailed Analysis — 2–4 subsections diving deeper; use **bold** leads and short tables where useful.
## Data Snapshot — a markdown table of the most important figures with sources.
## Perspectives & Criticisms — note conflicting views, controversies, or gaps in evidence.
## Outlook — informed projection, clearly labeled as outlook, not fact.
## Sources — numbered list matching the [n] markers.

# WRITING RULES:
- Cite sources inline like [1], [2] after EVERY factual claim. Never cite a source that isn't in the numbered list.
- Distinguish hard facts from claims, estimates, and speculation. Use phrases like "according to [3]", "reports suggest", "evidence indicates" as appropriate.
- Never invent data, URLs, names, or statistics. If something isn't in the sources, say it isn't covered or is unknown.
- If sources conflict, state the disagreement explicitly and show both sides with citations.
- Quantify: prefer specific numbers over vague adjectives ("~$120B market" not "huge market").
- Be precise about time: note recency or staleness of information.
- Write in crisp, professional prose. No fluff, no filler, no marketing tone.
- Markdown formatting: bold key terms, bullet lists, tables for comparisons.
- HIGHLIGHT IMPORTANT LINES & DATES: wrap the single most important fact in each section and every key date/year in ==double equals== so they render visually highlighted (e.g., ==July 2026==, ==$120B==, ==53%==). This is critical — the reader scans the highlighted text.
- Target 600–1000 words. No preamble — start directly with "## Executive Summary".`,
      user: `Today's date: ${today}

Research topic: "${query}"

Here are the web search results gathered from news, articles, papers, books, Q&A, market data, and reference sources:${readNote}

${packed}

Now write the professional research report following your structure exactly.`,
    };
  }

  // ── Chat prompt builder (conversational, uses the same provider chain) ──
  function buildChatPrompt(messages) {
    const transcript = (messages || []).slice(-12).map(m =>
      `${m.role === 'user' ? 'User' : 'Aurora'}: ${m.content}`).join('\n\n');
    return {
      system: CHAT_SYSTEM,
      user: `Conversation so far:\n\n${transcript}\n\nAnswer the latest question above.`,
    };
  }

  // Local chat fallback — works offline, always succeeds
  function localChatReply(messages) {
    const last = [...(messages || [])].reverse().find(m => m.role === 'user');
    const q = (last && last.content || '').slice(0, 200);
    return {
      markdown: `I'm running in offline/summary mode right now, so I'll give you a structured starting point for: *"${q}"*\n\n- Check the **News** tab for the latest live headlines.\n- Use the **Research** tab to generate a fully-sourced AI report.\n- The highlights (==dates==, ==numbers==) come from the AI report — try it!\n\n*(Reconnect to get my full conversational answers.)*`,
      provider: 'local',
    };
  }

  // ── Generic SSE reader for OpenAI-compatible streams ──
  async function streamOpenAICompat(res, onChunk) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    const parse = line => {
      const l = line.trim();
      if (!l.startsWith('data:')) return;
      const payload = l.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices && json.choices[0] &&
          (json.choices[0].delta || json.choices[0].message) && 
          (json.choices[0].delta || json.choices[0].message).content;
        if (typeof delta === 'string' && delta) {
          text += delta;
          onChunk(delta);
        }
      } catch { /* partial frame */ }
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop();
      for (const p of parts) parse(p);
    }
    parse(buffer); // flush tail
    return text;
  }

  // ── 1. Pollinations (keyless, GET-first; streaming POST attempt) ──
  async function pollinations(prompt, handlers, signal) {
    const { onProgress, onChunk } = handlers;
    const maxAttempts = 3;

    // Streaming POST attempt (may 402/429 on anonymous tier — fall through on failure)
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetch('https://text.pollinations.ai/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [
              { role: 'system', content: prompt.system },
              { role: 'user', content: prompt.user },
            ],
            model: 'openai',
            stream: true,
          }),
          signal,
        });
        if (res.ok && res.body) {
          onProgress(PROGRESS.synthesizing, 0.35);
          const text = await streamOpenAICompat(res, onChunk);
          if (text.trim()) { onProgress(PROGRESS.finalizing, 1); return { markdown: text, provider: 'pollinations' }; }
        } else if (res.status === 429) {
          await sleep(2500 * attempt); // queue full — back off and retry
          continue;
        }
      } catch (e) {
        if (e.name === 'AbortError') throw e;
      }
    }

    // GET fallback (plain text) — keep payload small to dodge URL limits & cost gates
    onProgress(PROGRESS.synthesizing, 0.45);
    const promptText = `${prompt.system}\n\n${prompt.user}`;
    const trimmed = promptText.length > 9000 ? promptText.slice(0, 9000) : promptText;
    const res = await fetch(
      `https://text.pollinations.ai/${encodeURIComponent(trimmed)}?model=openai&json=false`,
      { signal });
    if (!res.ok) throw new Error(`AI service unavailable (${res.status}).`);
    const text = await res.text();
    if (!text.trim()) throw new Error('AI returned an empty response.');
    onProgress(PROGRESS.finalizing, 1);
    return { markdown: text, provider: 'pollinations' };
  }

  // ── 2. Gemini (needs free API key) ──
  async function gemini(prompt, settings, handlers, signal) {
    const { onProgress, onChunk } = handlers;
    const key = settings.geminiKey;
    if (!key) throw new Error('Add a Gemini API key in Settings first.');
    const model = settings.geminiModel || 'gemini-2.5-flash';

    onProgress(PROGRESS.synthesizing, 0.4);
    const body = {
      contents: [{ role: 'user', parts: [{ text: `${prompt.system}\n\n${prompt.user}` }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
    };
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`Gemini error (${res.status}): ${err.slice(0, 120)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop();
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith('data:')) continue;
        try {
          const json = JSON.parse(line.slice(5).trim());
          const piece = json.candidates && json.candidates[0] && json.candidates[0].content &&
            json.candidates[0].content.parts && json.candidates[0].content.parts[0].text;
          if (typeof piece === 'string' && piece) {
            text += piece;
            onChunk(piece);
          }
        } catch { /* partial frame */ }
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith('data:')) {
      try {
        const json = JSON.parse(tail.slice(5).trim());
        const piece = json.candidates && json.candidates[0] && json.candidates[0].content &&
          json.candidates[0].content.parts && json.candidates[0].content.parts[0].text;
        if (typeof piece === 'string' && piece) { text += piece; onChunk(piece); }
      } catch { /* not a complete frame */ }
    }
    if (!text.trim()) throw new Error('Gemini returned an empty response.');
    onProgress(PROGRESS.finalizing, 1);
    return { markdown: text, provider: 'gemini' };
  }

  // ── 3. Groq (generous free tier, needs key — CORS verified) ──
  async function groq(prompt, settings, handlers, signal) {
    const { onProgress, onChunk } = handlers;
    const key = settings.groqKey;
    if (!key) throw new Error('Add a Groq API key in Settings first.');
    const model = settings.groqModel || 'llama-3.3-70b-versatile';

    onProgress(PROGRESS.synthesizing, 0.4);
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        temperature: 0.6,
        max_tokens: 2400,
        stream: true,
      }),
      signal,
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`Groq error (${res.status}): ${err.slice(0, 120)}`);
    }
    const text = await streamOpenAICompat(res, onChunk);
    if (!text.trim()) throw new Error('Groq returned an empty response.');
    onProgress(PROGRESS.finalizing, 1);
    return { markdown: text, provider: 'groq' };
  }

  // ── 4. OpenRouter (free tier models, needs key) ──
  async function openRouter(prompt, settings, handlers, signal) {
    const { onProgress, onChunk } = handlers;
    const key = settings.openrouterKey;
    if (!key) throw new Error('Add an OpenRouter API key in Settings first.');
    const model = settings.openrouterModel || 'meta-llama/llama-3.3-70b-instruct:free';

    onProgress(PROGRESS.synthesizing, 0.4);
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
        'HTTP-Referer': window.location.origin,
        'X-Title': 'Aurora Research',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        stream: true,
      }),
      signal,
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`OpenRouter error (${res.status}): ${err.slice(0, 120)}`);
    }
    const text = await streamOpenAICompat(res, onChunk);
    if (!text.trim()) throw new Error('OpenRouter returned an empty response.');
    onProgress(PROGRESS.finalizing, 1);
    return { markdown: text, provider: 'openrouter' };
  }

  // ── 5. Local synthesis — guaranteed fallback, works offline ──
  function localSynthesis(query, results) {
    // Scope to top 12 so every cited item maps to a valid [1..12] index
    const top = results.slice(0, 12);
    const groups = {};
    for (const r of top) (groups[r.source] = groups[r.source] || []).push(r);

    const meta = {
      wikipedia: 'Wikipedia',
      hackernews: 'Hacker News',
      web: 'Web results',
      academic: 'Academic papers',
      news: 'News articles',
      books: 'Books',
      qa: 'Q&A',
      code: 'Code repositories',
      markets: 'Market data',
      weather: 'Live weather',
    };

    const lines = [];
    lines.push(`## Executive Summary`);
    lines.push('');
    lines.push(`This report aggregates **${results.length}** search results from ` +
      `${Object.keys(groups).map(k => meta[k] || k).join(', ')} for the topic *"${query}"*. ` +
      `The most relevant sources indicate the topic is actively discussed across reference, news and academic channels. ` +
      `Below are the key findings, a source-by-source analysis, and full references.`);
    lines.push('');
    lines.push(`## Key Findings`);
    lines.push('');
    for (let i = 0; i < Math.min(6, top.length); i++) {
      const r = top[i];
      lines.push(`- **${r.title.slice(0, 110)}** — ${(r.snippet || 'See source for details.').slice(0, 130)} [${i + 1}]`);
    }
    lines.push('');
    lines.push(`## Detailed Analysis`);
    lines.push('');
    for (const [src, items] of Object.entries(groups)) {
      lines.push(`### ${meta[src] || src}`);
      lines.push('');
      for (const r of items.slice(0, 3)) {
        const idx = top.indexOf(r) + 1;
        lines.push(`- ${r.title} [${idx}] — ${(r.snippet || '').slice(0, 160)}`);
      }
      lines.push('');
    }
    lines.push(`## Sources`);
    lines.push('');
    results.slice(0, 12).forEach((r, i) => {
      lines.push(`${i + 1}. [${r.title}](${r.url})`);
    });
    lines.push('');
    lines.push(`---`);
    lines.push(`*Auto-generated summary from search results (AI provider unavailable). Review sources for details.*`);

    return { markdown: lines.join('\n'), provider: 'local' };
  }

  // ── Orchestrator ──
  async function generate(query, results, settings, handlers, signal, fullContent) {
    const prompt = buildPrompt(query, results, fullContent);
    try {
      return await runChain(prompt, settings, handlers, signal);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      handlers.onProgress && handlers.onProgress(PROGRESS.preparing, 1);
      return localSynthesis(query, results);
    }
  }

  // ── Chat: conversational completion through the same provider chain ──
  async function chat(messages, settings, handlers, signal) {
    const prompt = buildChatPrompt(messages);
    try {
      const out = await runChain(prompt, settings, handlers, signal);
      return out;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      handlers.onProgress && handlers.onProgress(PROGRESS.preparing, 1);
      return localChatReply(messages);
    }
  }

  // Shared provider fallback chain: selected keyed provider → other keyed → pollinations → local
  async function runChain(prompt, settings, handlers, signal) {
    const errors = [];
    const attempts = [];
    const add = (n, fn) => { if (!attempts.some(a => a.n === n)) attempts.push({ n, fn }); };

    if (settings.provider === 'gemini' && settings.geminiKey) add('gemini', () => gemini(prompt, settings, handlers, signal));
    else if (settings.provider === 'groq' && settings.groqKey) add('groq', () => groq(prompt, settings, handlers, signal));
    else if (settings.provider === 'openrouter' && settings.openrouterKey) add('openrouter', () => openRouter(prompt, settings, handlers, signal));

    if (settings.geminiKey) add('gemini', () => gemini(prompt, settings, handlers, signal));
    if (settings.groqKey) add('groq', () => groq(prompt, settings, handlers, signal));
    if (settings.openrouterKey) add('openrouter', () => openRouter(prompt, settings, handlers, signal));
    add('pollinations', () => pollinations(prompt, handlers, signal));

    for (const attempt of attempts) {
      try {
        return await attempt.fn();
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        errors.push(`${attempt.n}: ${e.message}`);
      }
    }

    handlers.onProgress && handlers.onProgress(PROGRESS.preparing, 1);
    throw new Error(errors.join(' | ') || 'All providers failed');
  }

  return { generate, chat, buildPrompt, buildChatPrompt, localChatReply, localSynthesis, PROGRESS };
})();
