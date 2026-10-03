import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  PositiveInt,
  ProjectId,
  TaskId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { SourceControlProviderKind } from "./sourceControl.ts";

/**
 * Why a thread exists. `user` threads are started by a person; the others are
 * created by the server for a task (for example to address new review
 * comments). Absent or null on older threads means `user`.
 */
export const ThreadOrigin = Schema.Literals(["user", "review-feedback", "ci-failure", "system"]);
export type ThreadOrigin = typeof ThreadOrigin.Type;

/** Setup logs are a capped tail so a noisy install never bloats events or the shell. */
const TASK_SETUP_LOG_MAX_CHARS = 16_000;

export const OrchestrationTaskSetupStatus = Schema.Literals([
  "pending",
  "running",
  "ready",
  "failed",
]);
export type OrchestrationTaskSetupStatus = typeof OrchestrationTaskSetupStatus.Type;

export const OrchestrationTaskSetupStepStatus = Schema.Literals([
  "pending",
  "running",
  "done",
  "failed",
  "skipped",
]);
export type OrchestrationTaskSetupStepStatus = typeof OrchestrationTaskSetupStepStatus.Type;

export const OrchestrationTaskSetupStep = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  status: OrchestrationTaskSetupStepStatus,
  log: Schema.NullOr(Schema.String.check(Schema.isMaxLength(TASK_SETUP_LOG_MAX_CHARS))),
  startedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  finishedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
});
export type OrchestrationTaskSetupStep = typeof OrchestrationTaskSetupStep.Type;

export const OrchestrationTaskSetup = Schema.Struct({
  status: OrchestrationTaskSetupStatus,
  steps: Schema.Array(OrchestrationTaskSetupStep),
  error: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type OrchestrationTaskSetup = typeof OrchestrationTaskSetup.Type;

/**
 * The git worktree a task works in. Always checked out on an existing remote
 * branch (`remoteName/remoteBranch`) through the local tracking branch
 * `branch`; `path` is null until the worktree exists.
 */
export const OrchestrationTaskWorkspace = Schema.Struct({
  path: Schema.NullOr(TrimmedNonEmptyString),
  branch: TrimmedNonEmptyString,
  remoteName: TrimmedNonEmptyString,
  remoteBranch: TrimmedNonEmptyString,
  baseBranch: Schema.NullOr(TrimmedNonEmptyString),
  setup: OrchestrationTaskSetup,
});
export type OrchestrationTaskWorkspace = typeof OrchestrationTaskWorkspace.Type;

export const OrchestrationTaskPullRequestState = Schema.Literals([
  "open",
  "merged",
  "closed",
  "draft",
]);
export type OrchestrationTaskPullRequestState = typeof OrchestrationTaskPullRequestState.Type;

export const OrchestrationTaskChecksState = Schema.Literals([
  "none",
  "pending",
  "passing",
  "failing",
]);
export type OrchestrationTaskChecksState = typeof OrchestrationTaskChecksState.Type;

export const OrchestrationTaskReviewState = Schema.Literals([
  "none",
  "pending",
  "approved",
  "changes-requested",
]);
export type OrchestrationTaskReviewState = typeof OrchestrationTaskReviewState.Type;

/** The pull request a task owns, as last observed on the host. */
export const OrchestrationTaskPullRequest = Schema.Struct({
  provider: SourceControlProviderKind,
  number: PositiveInt,
  url: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  state: OrchestrationTaskPullRequestState,
  headBranch: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  checks: OrchestrationTaskChecksState,
  review: OrchestrationTaskReviewState,
  linkedAt: IsoDateTime,
  observedAt: IsoDateTime,
});
export type OrchestrationTaskPullRequest = typeof OrchestrationTaskPullRequest.Type;

/**
 * A unit of work on one existing remote branch. Owns its workspace and pull
 * request; threads join it through `OrchestrationThread.taskId`. Status is
 * never stored: see `deriveTaskStatus` in `@t3tools/shared/taskStatus`.
 */
export const OrchestrationTask = Schema.Struct({
  id: TaskId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  description: Schema.NullOr(Schema.String),
  workspace: OrchestrationTaskWorkspace,
  pullRequest: Schema.NullOr(OrchestrationTaskPullRequest),
  autoHandleReviewFeedback: Schema.Boolean,
  autoHandleCIFailures: Schema.Boolean,
  waitingForUserReason: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  mergedAt: Schema.NullOr(IsoDateTime),
  archivedAt: Schema.NullOr(IsoDateTime),
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationTask = typeof OrchestrationTask.Type;

// The task document is small, so the shell carries all of it.
export const OrchestrationTaskShell = OrchestrationTask;
export type OrchestrationTaskShell = OrchestrationTask;

export const TaskCreateInput = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(20_000))),
  /** Defaults to the project's default remote (usually `origin`). */
  remoteName: Schema.optionalKey(TrimmedNonEmptyString),
  /** An existing branch on the remote. Tasks never create remote branches. */
  branch: TrimmedNonEmptyString,
  autoHandleReviewFeedback: Schema.optionalKey(Schema.Boolean),
});
export type TaskCreateInput = typeof TaskCreateInput.Type;

export const TaskCreateResult = Schema.Struct({
  taskId: TaskId,
  threadId: Schema.optionalKey(ThreadId),
});
export type TaskCreateResult = typeof TaskCreateResult.Type;

export const TaskIdInput = Schema.Struct({
  taskId: TaskId,
});
export type TaskIdInput = typeof TaskIdInput.Type;

export const TaskArchiveBlocker = Schema.Literals([
  "uncommitted-changes",
  "unpushed-commits",
  "pull-request-open",
  "agent-running",
]);
export type TaskArchiveBlocker = typeof TaskArchiveBlocker.Type;

export const TaskArchiveCheckResult = Schema.Struct({
  blockers: Schema.Array(TaskArchiveBlocker),
});
export type TaskArchiveCheckResult = typeof TaskArchiveCheckResult.Type;

export const TaskArchiveInput = Schema.Struct({
  taskId: TaskId,
  /** Required when the archive check reports any blocker. */
  force: Schema.optionalKey(Schema.Boolean),
});
export type TaskArchiveInput = typeof TaskArchiveInput.Type;

export const TaskCreateThreadInput = Schema.Struct({
  taskId: TaskId,
  title: Schema.optionalKey(TrimmedNonEmptyString),
});
export type TaskCreateThreadInput = typeof TaskCreateThreadInput.Type;

export const TaskCreateThreadResult = Schema.Struct({
  threadId: ThreadId,
});
export type TaskCreateThreadResult = typeof TaskCreateThreadResult.Type;

export const TaskOperationErrorReason = Schema.Literals([
  "not-found",
  "archived",
  "remote-branch-missing",
  "invalid-branch",
  "archive-blocked",
  "not-implemented",
  "failed",
]);
export type TaskOperationErrorReason = typeof TaskOperationErrorReason.Type;

export class TaskOperationError extends Schema.TaggedError<TaskOperationError>()(
  "TaskOperationError",
  {
    reason: TaskOperationErrorReason,
    message: TrimmedNonEmptyString,
    blockers: Schema.optional(Schema.Array(TaskArchiveBlocker)),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
