#!/usr/bin/env bash
# Rebase the fork onto upstream/main and regenerate the brand overlay commit. See fork/SYNC.md.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

SUBJECT="chore(brand): apply Merge brand overlay [generated]"

if [ -n "$(git status --porcelain)" ]; then
  echo "sync: the working tree is dirty (including untracked files); commit or remove them first." >&2
  exit 1
fi
if [ "$(git log -1 --format=%s)" = "$SUBJECT" ]; then
  git reset --hard HEAD~1
fi

git fetch upstream
git rebase upstream/main
node fork/check-seams.ts
node fork/brand/apply.ts
# Copy shortens lines, so let the formatter rejoin them before committing.
git diff --name-only -z | xargs -0 vp fmt --no-error-on-unmatched-pattern
# The tree was clean, so everything here is overlay output, including new asset files.
git add -A
git commit -m "$SUBJECT"
