# Syncing Merge with upstream T3 Code

Merge is upstream T3 Code plus three things:

1. **Fork code** in `fork/`, `*/src/merge/` and `packages/source-control-azure-devops/`.
2. **Seams**: small edits to upstream files, each marked `// merge-seam: <id>` (`{/* merge-seam: <id> */}` in JSX, `# merge-seam: <id>` in YAML, `<!-- merge-seam: <id> -->` in Markdown) and listed in `fork/seams.json`.
3. **Brand overlay**: one generated commit, `chore(brand): apply Merge brand overlay [generated]`, always on top. Never edit it by hand; change `fork/brand/rules.ts` or `fork/brand/assets/` and regenerate.

## Run a sync

With Node 26 and `vp` on `PATH`, a clean tree and an `upstream` remote (`https://github.com/pingdotgg/t3code`):

1. `git fetch upstream`, then on a fresh branch from the fork's main run `fork/sync.sh`.
   It finds the generated brand commit by its exact subject anywhere in `upstream/main..HEAD` (it may sit below later commits such as the release workflow's `chore(release): prepare vX` bump) and drops just that commit with `fork/drop-overlay.sh` (`git rebase --onto <sha>^ <sha>`); it refuses if more than one is found. It then rebases onto `upstream/main`, runs `node fork/check-seams.ts`, re-applies the overlay, formats the touched files and commits the overlay again.
2. Resolve conflicts and seam failures (next section), then rerun the rest of the script by hand.
3. Re-delete upstream workflows the fork does not use (see below).
4. Verify:
   - `node --test 'fork/**/*.test.ts'` (includes the temp-repo test of `drop-overlay.sh`)
   - `node fork/check-seams.ts`: every seam marker present, and `T3_CODE_BASELINE_VERSION` (`apps/server/src/merge/t3Baseline.ts`) equal to the `apps/server/package.json` version at `git merge-base HEAD upstream/main` (the drift check). It compares against the merge-base, not live `upstream/main`, so it fires after a sync moves the merge-base, not on every upstream bump.
   - `node fork/brand/apply.ts --check` exits 0 on a fully branded tree. CI runs all three in the `Fork checks` job; the `--check` only passes on a branch that carries the generated brand commit.
   - the budget json: `cd apps/server && vp test run src/provider/AgentContextBudget.test.ts`.
   - the repo-wide checks AGENTS.md requires (`vp run fmt`, `vp run lint`, `vp run typecheck`, `vp run test`).
5. Real-data migration test: copy a real `~/.merge/userdata` with `sqlite3 <src>/state.sqlite "VACUUM INTO '<copy>/state.sqlite'"` (never open the live DB read-write), start the server on the copy, and confirm every thread and task is listed, fork links and folders survive, and `merge_fork_migrations` is populated while `effect_sql_migrations` holds only upstream rows. Then start the previous Merge release on the same home to confirm rollback still works.

## Workflows

CI and release run from the fork on GitHub-hosted runners. Kept: `ci.yml`, `release.yml`, `release-desktop.yml`, `windows-tests.yml`, `pr-size.yml`, `issue-labels.yml`, `mobile-eas-preview.yml`, `mobile-eas-production.yml`. Edited kept files carry `# merge-seam:` markers (`ci-hosted`, `ci-fork-checks`, `release-fork`, `release-desktop-fork`, `windows-tests-fork`, `mobile-eas-*-fork`). Releases publish to GitHub `jonathanfernandezfm/merge` with `GITHUB_TOKEN`, and never read Clerk or relay config, so release builds cannot bake in hosted T3 services. After a sync, run `grep -rniE 'clerk|relay_|blacksmith|pingdotgg' .github/workflows`; only comments should match.

Deleted upstream workflows (a deleted file cannot hold a marker): re-delete on sync if upstream re-adds or changes them.

`agent-context-budget.yml`, `deploy-relay.yml`, `desktop-macos-preview.yml`, `desktop-macos-preview-publish.yml`, `mobile-android-apk.yml`, `mobile-fingerprint-check.yml`, `mobile-showcase-screenshots.yml`, `pr-vouch.yml`, `publish-aur.yml`, `relay-preview.yml`, `relay-preview-cleanup.yml`, `stale-needs-more-info.yml`, `thread-transfer-report.yml`, `web-preview.yml`.

Also deleted: `.github/actions/setup-apt-mirrors/` and the scripts only those workflows used (`relay-state-output.test.cjs`, `stage-preview-bundle.py`, `stage-preview-bundle.test.py`, `thread-transfer-report.cjs`, `thread-transfer-report.test.cjs`, `vercel-deployment-output.test.cjs`). `release.yml` also drops the `relay_public_config`, `publish_cli`, `publish_aur`, `build_web`, `deploy_web`, `build_marketing` and `deploy_marketing` jobs and the nightly `schedule`. It keeps upstream's `announce_discord` job (its steps are read by `scripts/notify-discord-release.test.ts`), gated on the repository variable `DISCORD_RELEASE_ANNOUNCEMENTS == 'true'`. When upstream edits those regions, keep the fork's version.

## When something breaks

- **Rebase conflict**: resolve it as usual (keep the seam marker with its line), `git rebase --continue`, then rerun the rest of the script by hand from `node fork/check-seams.ts`.
- **`missing seam <id> in <file>`**: upstream moved or rewrote the code around that seam. Re-add the call and its marker where the same hook now lives, or update the entry in `fork/seams.json` if the file moved.
- **Conflict in `apps/server/src/provider/agentContextBudget.json`** (seam `context-budget`, `"check": "measured"`, so it has no marker): take upstream's file, run `cd apps/server && vp test run src/provider/AgentContextBudget.test.ts`, and commit the measured values the failure reports. The fork's MCP tools add to `mcpToolListJsonBytes`.
- **Conflict in `LICENSE` or the generated `apps/mobile/generated-uniwind-theme-names.json`, `generated-uniwind-themes.css`, `uniwind-types.d.ts`** (seams with `"check": "measured"`, no marker): take upstream's version for `LICENSE` and re-apply the fork edit; regenerate the three mobile files with `apps/mobile/scripts/generate-uniwind-themes.mts`.
- **`T3_CODE_BASELINE_VERSION is X but upstream at the merge-base is Y`**: the provider-manifest baseline in `apps/server/src/merge/t3Baseline.ts` must track upstream's `apps/server/package.json` version at the merge-base. Set it to Y after the rebase (`node fork/check-seams.ts` checks it whenever an `upstream/main` ref exists).
- **`missing anchor <file>: <from>`**: upstream changed an identity string. Find its new form with `git grep`, update `from` (and `to`, if the shape changed) in `fork/brand/rules.ts`, and rerun `node fork/brand/apply.ts`. Anchors are exact strings on purpose, so drift fails loudly instead of shipping T3 Code identity.
- **`drifted overlay <path>`**: upstream changed a file the overlay replaces (an icon or wordmark). Compare upstream's new version with `fork/brand/assets/<path>`, update the asset if needed, then run `node fork/brand/apply.ts --relock` to record the new upstream blob and rerun `node fork/brand/apply.ts`.

## Tests

```sh
node --test 'fork/**/*.test.ts'
```
