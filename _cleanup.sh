#!/bin/bash
set -e
cd "$(dirname "$0")"
rm -f _deploy.sh
git rm --cached _deploy.sh 2>/dev/null || true
rm -f _deploy.sh
git add -A
git commit -m "chore: remove one-shot deploy helper script"
git push origin main
echo "=== cleaned ==="
