/**
 * TaskSupervisorReactor - watches the pull request of every active task.
 *
 * Each minute, and right after a task is created, finishes setup, opts into
 * review automation or has its pull request merged in the app, it finds the
 * task branch's pull request, keeps the task's PR snapshot (state, checks,
 * review, merge) current and records normalized workspace events in the
 * `task_scm_events` ledger. New review comments are batched into one automated
 * `review-feedback` thread, but only while no thread of the task is running;
 * otherwise they wait in the ledger until a task thread's session stops.
 *
 * All durable state lives in the ledger and the task read model, so the
 * supervisor can restart at any point without losing or repeating work.
 *
 * @module TaskSupervisorReactor
 */
import {
  CommandId,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationTask,
  type OrchestrationThreadShell,
  type PullRequestActivity,
  type PullRequestDetail,
  type TaskId,
  ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as GitManager from "../git/GitManager.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { pullRequestMatchesProject } from "../orchestration/ThreadPullRequestReactor.ts";
import * as ProjectionTasks from "../persistence/ProjectionTasks.ts";
import * as TaskScmEvents from "../persistence/TaskScmEvents.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { forkParked } from "../serverActivation.ts";
import * as TaskWorkspaceService from "./TaskWorkspaceService.ts";
import {
  normalizeTaskPullRequest,
  ReviewCommentPayload,
  reviewFeedbackPrompt,
  reviewFeedbackThreadTitle,
  type TaskWorkspaceEvent,
} from "./taskWorkspaceEvents.ts";

/**
 * How often the slower detail and conversation reads repeat for an open pull
 * request whose `updatedAt` has not moved. A new comment normally moves it, so
 * this only bounds how late a host that does not bump it is noticed.
 */
const DEEP_READ_INTERVAL_MS = 5 * 60 * 1_000;

const REVIEW_COMMENT = "review-comment-added";

/**
 * A claim older than this was abandoned by a dispatch that died mid-way. A live
 * dispatch settles within one worker request, far sooner.
 */
const STUCK_CLAIM_MS = 10 * 60 * 1_000;

export class TaskSupervisorReactor extends Context.Service<
  TaskSupervisorReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
    /** Evaluate one task now, or every active task when `taskId` is omitted. */
    readonly requestEvaluation: (taskId?: TaskId) => Effect.Effect<void>;
  }
>()("merge-agent/task/TaskSupervisorReactor") {}

type Request =
  | { readonly kind: "sweep" }
  | { readonly kind: "task"; readonly taskId: TaskId }
  /** A task thread went idle: only queued feedback needs another look. */
  | { readonly kind: "thread"; readonly threadId: ThreadId };

/** Not archived, not merged, set up, and with a worktree to point threads at. */
const isSupervisedTask = (task: OrchestrationTask): boolean =>
  task.archivedAt === null &&
  task.deletedAt === null &&
  task.mergedAt === null &&
  task.workspace.setup.status === "ready" &&
  task.workspace.path !== null;

const isThreadRunning = (thread: OrchestrationThreadShell): boolean =>
  thread.session?.status === "running" ||
  thread.session?.status === "starting" ||
  thread.latestTurn?.state === "running";

/**
 * Ledger state for a freshly observed event. Comments present when the PR was
 * first linked are a baseline and never trigger automation.
 */
const initialLedgerState = (
  event: TaskWorkspaceEvent,
  task: OrchestrationTask,
  firstLink: boolean,
): TaskScmEvents.TaskScmEventState => {
  switch (event.type) {
    case "review-comment-added":
      return firstLink ? "ignored" : "pending";
    case "checks-failed":
      // CI automation seam: a dispatcher for `ci-failure` threads would claim
      // these pending rows the way review comments are claimed below.
      return task.autoHandleCIFailures ? "pending" : "ignored";
    default:
      return "ignored";
  }
};

const decodeCommentPayload = Schema.decodeUnknownOption(
  Schema.fromJsonString(ReviewCommentPayload),
);

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const git = yield* GitManager.GitManager;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const workspaces = yield* TaskWorkspaceService.TaskWorkspaceService;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const tasks = yield* ProjectionTasks.make;
  const ledger = yield* TaskScmEvents.make;

  /** Last deep read per task: which PR revision, and when. Losing it costs one extra read. */
  const lastDeepRead = new Map<TaskId, { readonly revision: string; readonly atMs: number }>();

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);

  const logSkipped =
    (message: string, fields: Record<string, unknown>) =>
    <E>(cause: Cause.Cause<E>): Effect.Effect<void, E> =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning(message, { ...fields, cause: Cause.pretty(cause) });

  // --- Observe: pull request snapshot + ledger -----------------------------

  const observe = Effect.fn("TaskSupervisorReactor.observe")(function* (
    task: OrchestrationTask,
    project: OrchestrationProjectShell,
  ) {
    const repository = sourceControlRepositorySelector(project.repositoryIdentity);
    if (repository === null) return;
    const workspacePath = task.workspace.path;
    // Worktrees share refs with the main checkout, so the root can answer for
    // a worktree that was removed outside the app.
    const cwd =
      workspacePath !== null && (yield* fileSystem.exists(workspacePath))
        ? workspacePath
        : project.workspaceRoot;
    const detected = yield* git.branchPullRequest({ cwd, branch: task.workspace.branch });
    // A branch whose PR disappears keeps the last snapshot rather than losing it.
    if (detected === null || !pullRequestMatchesProject(detected, project)) return;

    const reference = { projectId: project.id, repository, number: detected.number };
    const summary = yield* pullRequests.summary(reference, { recoverTransientFailure: false });
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    const observedAt = DateTime.formatIso(now);
    const previous = task.pullRequest;
    const firstLink = previous === null || previous.number !== summary.number;
    const revision = `${summary.number}:${summary.updatedAt}`;
    const last = lastDeepRead.get(task.id);
    const deep =
      summary.state === "open" &&
      (firstLink ||
        last === undefined ||
        last.revision !== revision ||
        nowMs - last.atMs >= DEEP_READ_INTERVAL_MS);

    let detail: PullRequestDetail | null = null;
    let activity: PullRequestActivity | null = null;
    if (deep) {
      // A first link must read the conversation: without it, comments that
      // already exist could not be baselined and would look new next tick.
      const reads = Effect.all([pullRequests.detail(reference), pullRequests.activity(reference)], {
        concurrency: 2,
      });
      const result = firstLink
        ? yield* reads
        : yield* reads.pipe(
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) =>
                logSkipped("task pull request conversation read failed", { taskId: task.id })(
                  cause,
                ).pipe(Effect.as(null)),
            ),
          );
      if (result !== null) {
        [detail, activity] = result;
        lastDeepRead.set(task.id, { revision, atMs: nowMs });
      }
    }

    const normalized = normalizeTaskPullRequest(previous, {
      repository,
      summary,
      detail,
      activity,
      observedAt,
    });
    const rows = yield* Effect.forEach(normalized.events, (event) =>
      Effect.map(uuid, (id) => ({
        id,
        taskId: task.id,
        providerEventKey: event.key,
        type: event.type,
        payloadJson: JSON.stringify(event.payload),
        observedAt,
        state: initialLedgerState(event, task, normalized.firstLink),
      })),
    );
    // Ledger first: if the sync below fails, the next tick links again and
    // the baseline it records is still `ignored`.
    yield* ledger.insertIgnore(rows);

    const merged = normalized.pullRequest.state === "merged" && task.mergedAt === null;
    if (normalized.changed || merged) {
      yield* engine.dispatch({
        type: "task.sync",
        commandId: CommandId.make(`server:task-supervisor-sync:${task.id}:${yield* uuid}`),
        taskId: task.id,
        pullRequest: normalized.pullRequest,
        // Merge only records the fact. The workspace stays until an explicit archive.
        ...(merged ? { mergedAt: summary.mergedAt ?? observedAt } : {}),
      });
    }
  });

  // --- Dispatch: one automated thread per batch of pending comments --------

  const dispatchReviewFeedback = Effect.fn("TaskSupervisorReactor.dispatchReviewFeedback")(
    function* (task: OrchestrationTask) {
      const pullRequest = task.pullRequest;
      if (!isSupervisedTask(task) || !task.autoHandleReviewFeedback || pullRequest === null) {
        return;
      }
      if (!(yield* ledger.hasPending(task.id, REVIEW_COMMENT))) return;
      // One mutating agent per workspace: while any task thread runs, the
      // comments stay pending and a session stop re-evaluates the task.
      const shell = yield* snapshots.getShellSnapshot();
      if (shell.threads.some((thread) => thread.taskId === task.id && isThreadRunning(thread))) {
        yield* Effect.logDebug("task review feedback queued behind a running thread", {
          taskId: task.id,
        });
        return;
      }
      const now = yield* DateTime.now;
      const handledAt = DateTime.formatIso(now);
      // The thread id is minted before the claim and stored with it, so a
      // crash after the thread exists settles the claim as handled on recovery
      // instead of offering the comments to a second thread.
      const threadId = ThreadId.make(yield* uuid);
      const claimed = yield* ledger.claimPending(task.id, REVIEW_COMMENT, handledAt, threadId);
      if (claimed.length === 0) return;
      const comments = claimed
        .flatMap((row) => Option.toArray(decodeCommentPayload(row.payloadJson)))
        .toSorted(
          (left, right) =>
            left.createdAt.localeCompare(right.createdAt) ||
            left.commentId.localeCompare(right.commentId),
        );
      const ids = claimed.map((row) => row.id);
      if (comments.length === 0) {
        yield* ledger.settle({ ids, state: "failed", handledAt, handlingThreadId: null });
        return;
      }
      const created = yield* Effect.exit(
        workspaces.createThread({
          taskId: task.id,
          threadId,
          origin: "review-feedback",
          title: reviewFeedbackThreadTitle(
            DateTime.toParts(DateTime.setZone(now, DateTime.zoneMakeLocal())),
          ),
          initialMessage: reviewFeedbackPrompt({
            taskTitle: task.title,
            pullRequest,
            branch: task.workspace.branch,
            comments,
          }),
        }),
      );
      if (Exit.isSuccess(created)) {
        yield* ledger.settle({
          ids,
          state: "handled",
          handledAt,
          handlingThreadId: created.value.threadId,
        });
        return;
      }
      // No retry loop: failed rows stay failed until a person looks at them.
      yield* ledger.settle({ ids, state: "failed", handledAt, handlingThreadId: null });
      yield* Effect.logWarning("task review feedback thread could not be created", {
        taskId: task.id,
        events: ids.length,
        cause: Cause.pretty(created.cause),
      });
    },
  );

  // --- Evaluation ------------------------------------------------------------

  const readTask = (taskId: TaskId) =>
    snapshots.getTaskById(taskId).pipe(Effect.map(Option.filter(isSupervisedTask)));

  const evaluateTask = Effect.fn("TaskSupervisorReactor.evaluateTask")(function* (
    task: OrchestrationTask,
  ) {
    const project = yield* snapshots.getProjectShellById(task.projectId);
    if (Option.isNone(project)) return;
    yield* observe(task, project.value).pipe(
      Effect.catchCause(logSkipped("task pull request sync skipped", { taskId: task.id })),
    );
    // Read back what the sync wrote, including a merge that ends supervision.
    const current = yield* readTask(task.id);
    if (Option.isSome(current)) yield* dispatchReviewFeedback(current.value);
  });

  /** Release claims a crashed or interrupted dispatch left in `handling`. */
  const recoverStuckClaims = (claimedBefore: string | null) =>
    ledger
      .recoverStuck({ claimedBefore })
      .pipe(
        Effect.catch((error) => Effect.logWarning("task ledger recovery failed", { cause: error })),
      );

  const process = Effect.fn("TaskSupervisorReactor.process")(function* (request: Request) {
    switch (request.kind) {
      case "sweep": {
        const cutoff = DateTime.subtract(yield* DateTime.now, { milliseconds: STUCK_CLAIM_MS });
        yield* recoverStuckClaims(DateTime.formatIso(cutoff));
        const active = (yield* tasks.listActive()).filter(isSupervisedTask);
        for (const taskId of lastDeepRead.keys()) {
          if (!active.some((task) => task.id === taskId)) lastDeepRead.delete(taskId);
        }
        // The worker runs one request at a time and a sweep touches each task
        // once, so no task is ever evaluated twice concurrently.
        yield* Effect.forEach(
          active,
          (task) =>
            evaluateTask(task).pipe(
              Effect.catchCause(logSkipped("task supervision skipped", { taskId: task.id })),
            ),
          { concurrency: 4, discard: true },
        );
        return;
      }
      case "task": {
        const task = yield* readTask(request.taskId);
        if (Option.isSome(task)) yield* evaluateTask(task.value);
        return;
      }
      case "thread": {
        const thread = yield* snapshots.getThreadShellById(request.threadId);
        const taskId = Option.isSome(thread) ? thread.value.taskId : undefined;
        if (taskId == null) return;
        const task = yield* readTask(taskId);
        if (Option.isSome(task)) yield* dispatchReviewFeedback(task.value);
        return;
      }
    }
  });

  const worker = yield* makeDrainableWorker((request: Request) =>
    process(request).pipe(Effect.catchCause(logSkipped("task supervisor request failed", {}))),
  );

  const processEvent = (event: OrchestrationEvent) => {
    switch (event.type) {
      case "task.created":
        return worker.enqueue({ kind: "task", taskId: event.payload.taskId });
      // A task becomes supervised once setup is ready, so link its pull
      // request right away instead of on the next sweep.
      case "task.meta-updated":
        return event.payload.autoHandleReviewFeedback === true ||
          event.payload.workspace?.setup.status === "ready"
          ? worker.enqueue({ kind: "task", taskId: event.payload.taskId })
          : Effect.void;
      case "thread.session-set":
        return event.payload.session.status === "running" ||
          event.payload.session.status === "starting"
          ? Effect.void
          : worker.enqueue({ kind: "thread", threadId: event.payload.threadId });
      default:
        return Effect.void;
    }
  };

  const start: TaskSupervisorReactor["Service"]["start"] = Effect.fn("TaskSupervisorReactor.start")(
    function* () {
      // Nothing is mid-dispatch before the worker runs, so every claim is stale.
      yield* recoverStuckClaims(null);
      const events = yield* engine.subscribeDomainEvents;
      const merges = yield* pullRequests.subscribeMerges;
      yield* forkParked(Stream.runForEach(events, processEvent));
      // A merge made in the app lands on its task now instead of on the next sweep.
      yield* forkParked(
        Stream.runForEach(merges, (merge) =>
          tasks.listActive().pipe(
            Effect.flatMap((active) =>
              Effect.forEach(
                active.filter(
                  (task) =>
                    task.projectId === merge.projectId &&
                    task.pullRequest?.number === merge.number &&
                    isSupervisedTask(task),
                ),
                (task) => worker.enqueue({ kind: "task", taskId: task.id }),
                { discard: true },
              ),
            ),
            Effect.catch((error) =>
              Effect.logWarning("task merge lookup failed", { cause: error }),
            ),
          ),
        ),
      );
      yield* forkParked(
        Effect.gen(function* () {
          yield* worker.enqueue({ kind: "sweep" });
          yield* worker.drain;
        }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
      );
    },
  );

  const requestEvaluation: TaskSupervisorReactor["Service"]["requestEvaluation"] = (taskId) =>
    worker.enqueue(taskId === undefined ? { kind: "sweep" } : { kind: "task", taskId });

  return {
    start,
    drain: worker.drain,
    requestEvaluation,
  } satisfies TaskSupervisorReactor["Service"];
});

export const layer = Layer.effect(TaskSupervisorReactor, make);
