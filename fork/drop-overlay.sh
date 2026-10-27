#!/usr/bin/env bash
# Drop the generated brand commit from wherever it sits in upstream/main..HEAD. See fork/SYNC.md.
set -euo pipefail

SUBJECT="chore(brand): apply Merge brand overlay [generated]"
BASE="${1:-upstream/main}"

found=()
while IFS=$'\t' read -r sha subject; do
  [ "$subject" = "$SUBJECT" ] && found+=("$sha")
done < <(git log --format=$'%H\t%s' --fixed-strings --grep="$SUBJECT" "$BASE..HEAD")

if [ "${#found[@]}" -gt 1 ]; then
  echo "sync: found ${#found[@]} generated brand commits (${found[*]}); remove all but one by hand and rerun." >&2
  exit 1
fi
if [ "${#found[@]}" -eq 1 ]; then
  git rebase --onto "${found[0]}^" "${found[0]}"
fi
