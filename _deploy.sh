#!/bin/bash
# Aurora — stage, commit, and push for Netlify GitHub deploy
set -e
cd "$(dirname "$0")"

git add -A
git status --short

git commit -m "feat: anchor AI narration pass, quality dashboard, deploy hardening

- js/anchor.js: fix template-literal syntax error in AI script prompt;
  buildAiScript now accepts real settings (was nonexistent ai.__settings),
  bounded 12s timeout with heuristic fallback
- js/app.js: narrateScriptFromText tries AI-assisted scripts (token-guarded,
  awaited); openSettings populates narration quality dashboard metrics
- index.html + css/styles.css: narration quality section in Settings
- netlify/functions/aurora.js: pitch param for /api/tts; SSML phoneme attempt
  reverted (edge-tts-universal escapes input text)
- test-anchor.js: 9 new awaited tests (buildAiScript/parseAiScript, timeout)
- TTS-STRATEGY.md / README.md: anchor pipeline docs
- .gitignore: exclude .agents/.claude/skills-lock.json"

echo "=== pushing ==="
git push origin main
echo "=== done ==="
