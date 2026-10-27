import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "../auth.ts";
import {
  IsoDateTime,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "../baseSchemas.ts";
import { SourceControlProviderKind } from "../sourceControl.ts";

/** Brand stays `TaskId` so v0.0.10 rows and links keep matching. */
export const WorkTaskId = TrimmedNonEmptyString.pipe(Schema.brand("TaskId"));
export type WorkTaskId = typeof WorkTaskId.Type;

/** Why a thread joined a Work Task. Null on older links means `user`. */
export const WorkTaskThreadOrigin = Schema.Literals([
  "user",
  "review-feedback",
  "ci-failure",
  "system",
]);
export type WorkTaskThreadOrigin = typeof WorkTaskThreadOrigin.Type;

/** Setup logs are a capped tail so a noisy install never bloats the stream. */
const WORK_TASK_SETUP_LOG_MAX_CHARS = 16_000;

export const WorkTaskSetupStatus = Schema.Literals(["pending", "running", "ready", "failed"]);
export type WorkTaskSetupStatus = typeof WorkTaskSetupStatus.Type;

export const WorkTaskSetupStepStatus = Schema.Literals([
  "pending",
  "running",
  "done",
  "failed",
  "skipped",
]);
export type WorkTaskSetupStepStatus = typeof WorkTaskSetupStepStatus.Type;

export const WorkTaskSetupStep = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  status: WorkTaskSetupStepStatus,
  log: Schema.NullOr(Schema.String.check(Schema.isMaxLength(WORK_TASK_SETUP_LOG_MAX_CHARS))),
  startedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  finishedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
});
export type WorkTaskSetupStep = typeof WorkTaskSetupStep.Type;

export const WorkTaskSetup = Schema.Struct({
  status: WorkTaskSetupStatus,
  steps: Schema.Array(WorkTaskSetupStep),
  error: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type WorkTaskSetup = typeof WorkTaskSetup.Type;

/**
 * The worktree a Work Task works in, on the existing local branch `branch` that tracks
 * `remoteName/remoteBranch`. `path` is null until the worktree exists. Stored as
 * `projection_tasks.workspace_json` in the v0.0.10 shape.
 */
export const WorkTaskWorkspace = Schema.Struct({
  path: Schema.NullOr(TrimmedNonEmptyString),
  branch: TrimmedNonEmptyString,
  remoteName: TrimmedNonEmptyString,
  remoteBranch: TrimmedNonEmptyString,
  baseBranch: Schema.NullOr(TrimmedNonEmptyString),
  setup: WorkTaskSetup,
});
export type WorkTaskWorkspace = typeof WorkTaskWorkspace.Type;

export const WorkTaskPullRequestState = Schema.Literals(["open", "merged", "closed", "draft"]);
export type WorkTaskPullRequestState = typeof WorkTaskPullRequestState.Type;

export const WorkTaskChecksState = Schema.Literals(["none", "pending", "passing", "failing"]);
export type WorkTaskChecksState = typeof WorkTaskChecksState.Type;

export const WorkTaskReviewState = Schema.Literals([
  "none",
  "pending",
  "approved",
  "changes-requested",
]);
export type WorkTaskReviewState = typeof WorkTaskReviewState.Type;

/**
 * The pull request v0.0.10 polled for a task (`pull_request_json`). Read-only now: thread PR
 * links own the live state, and this is the fallback when no linked thread has a snapshot.
 */
export const WorkTaskLegacyPullRequest = Schema.Struct({
  provider: SourceControlProviderKind,
  number: PositiveInt,
  url: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  state: WorkTaskPullRequestState,
  headBranch: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  checks: WorkTaskChecksState,
  review: WorkTaskReviewState,
  linkedAt: IsoDateTime,
  observedAt: IsoDateTime,
});
export type WorkTaskLegacyPullRequest = typeof WorkTaskLegacyPullRequest.Type;

/**
 * A unit of work on one existing branch. Threads join it through `merge_thread_links`.
 * Status is never stored: see `deriveWorkTaskStatus`.
 */
export const WorkTask = Schema.Struct({
  id: WorkTaskId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  description: Schema.NullOr(Schema.String),
  workspace: WorkTaskWorkspace,
  legacyPullRequest: Schema.NullOr(WorkTaskLegacyPullRequest),
  autoHandleReviewFeedback: Schema.Boolean,
  waitingForUserReason: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  mergedAt: Schema.NullOr(IsoDateTime),
  archivedAt: Schema.NullOr(IsoDateTime),
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type WorkTask = typeof WorkTask.Type;

export const WorkTaskLink = Schema.Struct({
  threadId: ThreadId,
  taskId: WorkTaskId,
  origin: Schema.NullOr(WorkTaskThreadOrigin),
});
export type WorkTaskLink = typeof WorkTaskLink.Type;

/** Every Work Task (archived ones included) and every thread link, sent whole on each change. */
export const WorkTasksSnapshot = Schema.Struct({
  tasks: Schema.Array(WorkTask),
  links: Schema.Array(WorkTaskLink),
});
export type WorkTasksSnapshot = typeof WorkTasksSnapshot.Type;

export const WorkTaskIdInput = Schema.Struct({ taskId: WorkTaskId });
export type WorkTaskIdInput = typeof WorkTaskIdInput.Type;

export const WorkTaskArchiveBlocker = Schema.Literals([
  "uncommitted-changes",
  "unpushed-commits",
  "pull-request-open",
  "agent-running",
]);
export type WorkTaskArchiveBlocker = typeof WorkTaskArchiveBlocker.Type;

export const WorkTaskArchiveCheckResult = Schema.Struct({
  blockers: Schema.Array(WorkTaskArchiveBlocker),
});
export type WorkTaskArchiveCheckResult = typeof WorkTaskArchiveCheckResult.Type;

export const WorkTaskOperationErrorReason = Schema.Literals([
  "not-found",
  "archived",
  "remote-branch-missing",
  "invalid-branch",
  "branch-checked-out",
  "archive-blocked",
  "not-implemented",
  "failed",
]);
export type WorkTaskOperationErrorReason = typeof WorkTaskOperationErrorReason.Type;

export class WorkTaskOperationError extends Schema.TaggedError<WorkTaskOperationError>()(
  "WorkTaskOperationError",
  {
    reason: WorkTaskOperationErrorReason,
    message: TrimmedNonEmptyString,
    blockers: Schema.optional(Schema.Array(WorkTaskArchiveBlocker)),
    /** Set with `branch-checked-out`: the worktree holding the branch. */
    checkoutPath: Schema.optional(TrimmedNonEmptyString),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const WorkTasksError = Schema.Union([WorkTaskOperationError, EnvironmentAuthorizationError]);
