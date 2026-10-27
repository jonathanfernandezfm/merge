#!/usr/bin/env bash
# Rebase the fork onto upstream/main and regenerate the brand overlay commit. See fork/SYNC.md.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

SUBJECT="chore(brand): apply Merge brand overlay [generated]"

if [ -n "$(git status --porcelain)" ]; then
  echo "sync: the working tree is dirty (including untracked files); commit or remove them first." >&2
  exit 1
fi
git fetch upstream
# The overlay may sit below later fork commits (for example release version bumps).
fork/drop-overlay.sh upstream/main
git rebase upstream/main
node fork/check-seams.ts
node fork/brand/apply.ts
# Copy shortens lines, so let the formatter rejoin them before committing.
git diff --name-only -z | xargs -0 -r vp fmt --no-error-on-unmatched-pattern
# The tree was clean, so everything here is overlay output, including new asset files.
git add -A
git commit -m "$SUBJECT"
