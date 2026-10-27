import {
  GitCommandError,
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
  type GitGraphCommitDiffInput,
  type GitGraphCommitDiffResult,
  type GitGraphLogInput,
  type GitGraphLogResult,
} from "@t3tools/contracts";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { PATCH_RENDER_PREFIX_ARGS } from "../../vcs/GitVcsDriverCore.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as KnownWorkspaces from "../../workspace/KnownWorkspaces.ts";
import { GIT_GRAPH_LOG_FORMAT, parseGitGraphLog, sumNumstat } from "./parseLog.ts";

const COMMIT_LIMIT = 200;
const METADATA_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const PATCH_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const FALLBACK_BASE_BRANCHES = ["main", "master", "develop"];

/**
 * Looks the service up when a request runs instead of in the handler's type, so the fork RPC
 * handlers add no requirements to upstream's WS test harnesses. The server layer always has them.
 */
const lookup = <I, S>(key: Context.Key<I, S>) =>
  Effect.serviceOption(key).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.die(new Error(`Git graph: ${key.key} is not provided.`)),
        onSome: Effect.succeed,
      }),
    ),
  );

/** Resolves the git driver for `cwd` after the same workspace check the review RPCs make. */
const requireGit = Effect.fn("GitGraph.requireGit")(function* (operation: string, cwd: string) {
  const known = yield* lookup(KnownWorkspaces.KnownWorkspaces);
  yield* known.assertContains(cwd).pipe(
    Effect.mapError(
      (cause) =>
        new VcsRepositoryDetectionError({
          operation,
          cwd,
          detail: "The Git graph cwd must be a known workspace.",
          cause,
        }),
    ),
  );
  const registry = yield* lookup(VcsDriverRegistry.VcsDriverRegistry);
  const handle = yield* registry.detect({ cwd, requestedKind: "auto" });
  if (handle?.kind !== "git") {
    return yield* new VcsUnsupportedOperationError({
      operation,
      kind: handle?.kind ?? "unknown",
      detail: "The Git graph requires a Git repository.",
    });
  }
  return yield* lookup(GitVcsDriver.GitVcsDriver);
});

const gitOut = (
  git: GitVcsDriver.GitVcsDriver["Service"],
  operation: string,
  cwd: string,
  args: ReadonlyArray<string>,
  options?: { readonly maxOutputBytes?: number; readonly stdin?: string },
) =>
  git
    .execute({ operation, cwd, args, allowNonZeroExit: true, ...options })
    .pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : "")));

export const gitGraphLog = Effect.fn("GitGraph.log")(function* (input: GitGraphLogInput) {
  const op = "GitGraph.log";
  const git = yield* requireGit(op, input.cwd);
  const cwd = input.cwd;
  const branch =
    (yield* gitOut(git, `${op}.branch`, cwd, ["symbolic-ref", "--short", "-q", "HEAD"])) || null;
  const empty: GitGraphLogResult = {
    cwd,
    headRef: branch,
    baseRef: null,
    mergeBase: null,
    commits: [],
    truncated: false,
  };
  const head = yield* gitOut(git, `${op}.head`, cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (head.length === 0) return empty;

  const verifies = (ref: string) =>
    gitOut(git, `${op}.verify`, cwd, [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${ref}^{commit}`,
    ]).pipe(Effect.map((sha) => sha.length > 0));
  const automaticBase = Effect.gen(function* () {
    if (branch === null) return null;
    const recorded = yield* git.readBranchBase(cwd, branch).pipe(Effect.orElseSucceed(() => null));
    const remote = yield* git.resolvePrimaryRemoteName(cwd).pipe(Effect.orElseSucceed(() => null));
    const remoteDefault =
      remote === null
        ? null
        : yield* git.resolveDefaultBranchName(cwd, remote).pipe(Effect.orElseSucceed(() => null));
    for (const candidate of [recorded, remoteDefault, ...FALLBACK_BASE_BRANCHES]) {
      if (candidate && candidate !== branch && (yield* verifies(candidate))) return candidate;
    }
    return null;
  });
  const baseRef = input.baseRef ?? (yield* automaticBase);
  const mergeBase = baseRef
    ? (yield* gitOut(git, `${op}.mergeBase`, cwd, [
        "merge-base",
        "--end-of-options",
        baseRef,
        "HEAD",
      ])) || null
    : null;
  const limit = Math.max(1, Math.min(input.limit ?? COMMIT_LIMIT, COMMIT_LIMIT));
  const stdout = yield* gitOut(
    git,
    `${op}.log`,
    cwd,
    [
      "log",
      "--topo-order",
      "--no-color",
      `--max-count=${limit + 1}`,
      `--format=${GIT_GRAPH_LOG_FORMAT}`,
      "--end-of-options",
      ...(mergeBase ? ["HEAD", `^${mergeBase}`] : ["HEAD"]),
    ],
    { maxOutputBytes: METADATA_MAX_OUTPUT_BYTES },
  );
  const commits = parseGitGraphLog(stdout);
  return {
    cwd,
    headRef: branch ?? head,
    baseRef,
    mergeBase,
    commits: commits.slice(0, limit),
    truncated: commits.length > limit,
  } satisfies GitGraphLogResult;
});

export const gitGraphCommitDiff = Effect.fn("GitGraph.commitDiff")(function* (
  input: GitGraphCommitDiffInput,
) {
  const op = "GitGraph.commitDiff";
  const git = yield* requireGit(op, input.cwd);
  const cwd = input.cwd;
  const invalid = (detail: string) =>
    new GitCommandError({ operation: op, cwd, command: "git diff", detail });
  if (!/^[0-9a-f]{4,64}$/i.test(input.sha)) return yield* invalid("Invalid commit revision.");

  const sha = yield* gitOut(git, `${op}.resolve`, cwd, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${input.sha}^{commit}`,
  ]);
  if (sha.length === 0) return yield* invalid("Unknown commit.");
  const parentSha =
    (yield* gitOut(git, `${op}.parent`, cwd, [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${sha}^1^{commit}`,
    ])) || null;
  // A root commit diffs against the empty tree; stdin avoids a platform-specific null device.
  const base =
    parentSha ??
    (yield* gitOut(git, `${op}.emptyTree`, cwd, ["hash-object", "-t", "tree", "--stdin"], {
      stdin: "",
    }));

  const diffArgs = [
    "diff",
    "--find-renames",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    ...PATCH_RENDER_PREFIX_ARGS,
    ...(input.ignoreWhitespace ? ["-w"] : []),
  ];
  const range = [base, sha, "--"];
  const patch = yield* git.execute({
    operation: `${op}.patch`,
    cwd,
    args: [...diffArgs, ...range],
    maxOutputBytes: PATCH_MAX_OUTPUT_BYTES,
    appendTruncationMarker: true,
  });
  const stats = sumNumstat(
    yield* gitOut(git, `${op}.numstat`, cwd, [...diffArgs, "--numstat", ...range], {
      maxOutputBytes: METADATA_MAX_OUTPUT_BYTES,
    }),
  );
  return {
    cwd,
    sha,
    parentSha,
    diff: patch.stdoutTruncated ? "" : patch.stdout,
    truncated: patch.stdoutTruncated,
    ...stats,
  } satisfies GitGraphCommitDiffResult;
});
