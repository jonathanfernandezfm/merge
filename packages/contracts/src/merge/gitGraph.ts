import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "../auth.ts";
import { TrimmedNonEmptyString } from "../baseSchemas.ts";
import { ReviewDiffPreviewError } from "../review.ts";

export const GitGraphLogInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  /** Comparison target. Omitted means the branch's automatic base. */
  baseRef: Schema.optionalKey(TrimmedNonEmptyString),
  limit: Schema.optionalKey(Schema.Number),
});
export type GitGraphLogInput = typeof GitGraphLogInput.Type;

export const GitGraphCommit = Schema.Struct({
  sha: TrimmedNonEmptyString,
  parents: Schema.Array(TrimmedNonEmptyString),
  subject: Schema.String,
  body: Schema.String,
  authorName: Schema.String,
  authorEmail: Schema.String,
  authoredAt: Schema.String,
  /** Decorations such as branch and tag names pointing at this commit. */
  refs: Schema.Array(Schema.String),
});
export type GitGraphCommit = typeof GitGraphCommit.Type;

export const GitGraphLogResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  /** Where the branch left its base; null when there is no base or no shared history. */
  mergeBase: Schema.NullOr(TrimmedNonEmptyString),
  /** Branch-only commits (`base..HEAD`), newest first in topological order. */
  commits: Schema.Array(GitGraphCommit),
  truncated: Schema.Boolean,
});
export type GitGraphLogResult = typeof GitGraphLogResult.Type;

export const GitGraphCommitDiffInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  sha: TrimmedNonEmptyString,
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
});
export type GitGraphCommitDiffInput = typeof GitGraphCommitDiffInput.Type;

export const GitGraphCommitDiffResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  sha: TrimmedNonEmptyString,
  /** First parent; null for a root commit, which diffs against the empty tree. */
  parentSha: Schema.NullOr(TrimmedNonEmptyString),
  diff: Schema.String,
  /** True when the patch was cut at the size cap and must not be rendered. */
  truncated: Schema.Boolean,
  fileCount: Schema.Number,
  additions: Schema.Number,
  deletions: Schema.Number,
});
export type GitGraphCommitDiffResult = typeof GitGraphCommitDiffResult.Type;

export const GitGraphError = Schema.Union([ReviewDiffPreviewError, EnvironmentAuthorizationError]);
