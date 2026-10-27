# Syncing Merge with upstream T3 Code

Merge is upstream T3 Code plus three things:

1. **Fork code** in `fork/`, `*/src/merge/` and `packages/source-control-azure-devops/`.
2. **Seams**: small edits to upstream files, each marked `// merge-seam: <id>` (`{/* merge-seam: <id> */}` in JSX) and listed in `fork/seams.json`.
3. **Brand overlay**: one generated commit, `chore(brand): apply Merge brand overlay [generated]`, always on top. Never edit it by hand; change `fork/brand/rules.ts` or `fork/brand/assets/` and regenerate.

## Run a sync

With Node 26 and `vp` on `PATH`, a clean tree and an `upstream` remote:

```sh
fork/sync.sh
```

It drops the previous overlay commit, rebases onto `upstream/main`, checks the seams, re-applies the overlay, formats the touched files and commits the overlay again. `node fork/brand/apply.ts --check` exits 0 on a fully branded tree.

## When something breaks

- **Rebase conflict**: resolve it as usual (keep the seam marker with its line), `git rebase --continue`, then rerun the rest of the script by hand from `node fork/check-seams.ts`.
- **`missing seam <id> in <file>`**: upstream moved or rewrote the code around that seam. Re-add the call and its marker where the same hook now lives, or update the entry in `fork/seams.json` if the file moved.
- **`T3_CODE_BASELINE_VERSION is X but upstream/main is Y`**: the provider-manifest baseline in `apps/server/src/merge/t3Baseline.ts` must track upstream's `apps/server/package.json` version. Set it to Y after the rebase (`node fork/check-seams.ts` checks it whenever an `upstream/main` ref exists).
- **`missing anchor <file>: <from>`**: upstream changed an identity string. Find its new form with `git grep`, update `from` (and `to`, if the shape changed) in `fork/brand/rules.ts`, and rerun `node fork/brand/apply.ts`. Anchors are exact strings on purpose, so drift fails loudly instead of shipping T3 Code identity.
- **`drifted overlay <path>`**: upstream changed a file the overlay replaces (an icon or wordmark). Compare upstream's new version with `fork/brand/assets/<path>`, update the asset if needed, then run `node fork/brand/apply.ts --relock` to record the new upstream blob and rerun `node fork/brand/apply.ts`.

## Tests

```sh
node --test 'fork/**/*.test.ts'
```
