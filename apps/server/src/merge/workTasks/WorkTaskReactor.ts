import {
  CommandId,
  workTaskStatusInputs,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type WorkTask,
  type WorkTaskLink,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../../serverActivation.ts";
import {
  legacyThreadPullRequestKey,
  threadPullRequestKeysEqual,
  threadPullRequestsOf,
  visibleThreadPullRequests,
} from "../../sourceControl/threadPullRequests.ts";
import { WorkTaskStore } from "./WorkTaskStore.ts";
import { WorkTaskWorkspace, type WorkTaskLauncher } from "./WorkTaskWorkspace.ts";

const REVIEW_THREAD_TITLE = "Review feedback";
const REVIEW_LAUNCHER: WorkTaskLauncher = { createdBy: "system", creationSource: "server" };

/** Events that can change a link, a PR snapshot, an archive, or whether a thread is busy. */
const TRIGGERS: ReadonlySet<OrchestrationV2DomainEvent["type"]> = new Set([
  "thread.pull-request-synced",
  "thread.pull-request-link-updated",
  "thread.archived",
  "thread.unarchived",
  "run.created",
  "run.updated",
  "runtime-request.updated",
  "subagent.updated",
]);

const isLive = (shell: OrchestrationV2ThreadShell) =>
  shell.archivedAt === null && shell.deletedAt === null;

/**
 * Work Task layer on upstream's PR engine: links branch PRs, stamps `merged_at`, keeps one
 * "Review feedback" thread whose watch is held off while a sibling is busy, and unlinks revived
 * threads of archived tasks. Stateless: each pass re-derives from the store, so restarts are safe.
 */
export class WorkTaskReactor extends Context.Service<
  WorkTaskReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** One reconcile pass over every Work Task. Logs failures and never fails. */
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/merge/workTasks/WorkTaskReactor") {}

export const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const store = yield* WorkTaskStore;
  const workspace = yield* WorkTaskWorkspace;
  const crypto = yield* Crypto.Crypto;
  // Event wakes and the timer must not reconcile at once, or two passes could both launch a review thread.
  const lock = yield* Semaphore.make(1);

  const dispatch = (tag: string, command: (commandId: CommandId) => OrchestrationV2ServerCommand) =>
    crypto.randomUUIDv4().pipe(
      Effect.orDie,
      Effect.flatMap((id) =>
        engine.dispatch(command(CommandId.make(`merge:work-task-${tag}:${id}`))),
      ),
    );

  const logSkipped =
    (message: string, fields: Record<string, unknown>) =>
    <E>(cause: Cause.Cause<E>): Effect.Effect<void> =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning(message, { ...fields, cause: Cause.pretty(cause) });

  const reconcileActive = Effect.fn("WorkTaskReactor.reconcileActive")(function* (
    task: WorkTask,
    links: ReadonlyArray<WorkTaskLink>,
    shells: ReadonlyArray<OrchestrationV2ThreadShell>,
  ) {
    const branch = task.workspace.branch;
    const own = links.filter((link) => link.taskId === task.id);
    const ownIds = new Set<string>(own.map((link) => link.threadId));
    const threads = shells.filter((shell) => ownIds.has(shell.id) && isLive(shell));

    // PR linker: upstream finds the branch PR; linking it lets upstream sync its snapshot.
    for (const shell of threads) {
      const found = shell.branchPullRequest;
      if (!found || shell.branch !== branch) continue;
      const key = legacyThreadPullRequestKey(found);
      if (threadPullRequestsOf(shell).some((link) => threadPullRequestKeysEqual(link, key))) {
        continue;
      }
      yield* dispatch("pr-link", (commandId) => ({
        type: "thread.pull-request.link",
        commandId,
        threadId: shell.id,
        ...key,
        url: found.url,
        source: "agent",
      }));
    }

    // The task PR is the newest linked snapshot on the task branch, as status picks it.
    const pr = threads
      .flatMap((shell) => visibleThreadPullRequests(shell.pullRequests ?? []))
      .filter((link) => link.snapshot?.headBranch === branch)
      .sort((a, b) => b.linkedAt.localeCompare(a.linkedAt))[0];

    if (pr?.snapshot?.state === "merged" && task.mergedAt === null) {
      yield* store.update(task.id, {
        mergedAt: pr.snapshot.mergedAt ?? DateTime.formatIso(yield* DateTime.now),
      });
    }

    const reviewLink = own.find((link) => link.origin === "review-feedback");
    let review = shells.find((shell) => shell.id === reviewLink?.threadId) ?? null;
    const wanted =
      task.autoHandleReviewFeedback &&
      task.workspace.setup.status === "ready" &&
      pr !== undefined &&
      pr.snapshot?.state === "open";

    if (!wanted) {
      // Auto-handle is off or there is no open PR: the review thread watches nothing.
      if (review === null || !isLive(review)) return;
      const reviewId = review.id;
      for (const link of visibleThreadPullRequests(review.pullRequests ?? [])) {
        if (link.watch === undefined) continue;
        yield* dispatch("pr-unwatch", (commandId) => ({
          type: "thread.pull-request.watch",
          commandId,
          threadId: reviewId,
          host: link.host,
          repository: link.repository,
          number: link.number,
          watching: false,
        }));
      }
      return;
    }

    if (reviewLink === undefined) {
      // No initial message: a retried preparation with one would drop skipSetupScript.
      const { threadId } = yield* workspace.createThread(
        { taskId: task.id, title: REVIEW_THREAD_TITLE, origin: "review-feedback" },
        REVIEW_LAUNCHER,
      );
      review = yield* projections.getThreadShell(threadId);
    }
    // A review thread the user archived or settled is left alone.
    if (review === null || !isLive(review) || review.settledAt !== null) return;

    // Feedback hold: the review thread is woken only while every other task thread is idle.
    const busy = workTaskStatusInputs({
      taskId: task.id,
      task,
      links,
      shells: shells.filter(isLive),
    }).threads.some(
      (thread) =>
        thread.origin !== "review-feedback" &&
        (thread.state === "running" || thread.state === "waiting" || thread.state === "monitoring"),
    );
    const key = { host: pr.host, repository: pr.repository, number: pr.number };
    const watching =
      threadPullRequestsOf(review).find((link) => threadPullRequestKeysEqual(link, key))?.watch !==
      undefined;
    if (watching === !busy) return;
    yield* dispatch(busy ? "pr-hold" : "pr-watch", (commandId) => ({
      type: "thread.pull-request.watch",
      commandId,
      threadId: review.id,
      ...key,
      watching: !busy,
      ...(busy
        ? {}
        : {
            // Comments posted during the hold are delivered now, once.
            resumeRemarksFromEndedWatch: true,
            // manual: an agent-source watch is refused after the user stopped the thread's last run.
            link: { url: pr.url, source: "manual" as const },
          }),
    }));
  });

  /** A thread unarchived after its task was archived becomes an ordinary thread. */
  const unlinkRevived = Effect.fn("WorkTaskReactor.unlinkRevived")(function* (
    task: WorkTask,
    links: ReadonlyArray<WorkTaskLink>,
    shells: ReadonlyArray<OrchestrationV2ThreadShell>,
  ) {
    for (const link of links) {
      if (link.taskId !== task.id) continue;
      const shell = shells.find((candidate) => candidate.id === link.threadId);
      if (shell !== undefined && isLive(shell)) yield* store.unlink(link.threadId);
    }
  });

  const pass = Effect.gen(function* () {
    const tasks = yield* store.list();
    const links = yield* store.links();
    const linked = new Set<string>(links.map((link) => link.threadId));
    // Subagent children count toward their root's busy state.
    const subagents = (yield* projections.listActiveSubagentThreadIds()).filter(
      (id) => !linked.has(id),
    );
    const shells = (yield* Effect.forEach(
      [...links.map((link) => link.threadId), ...subagents],
      (id) => projections.getThreadShell(id),
      { concurrency: 8 },
    )).filter((shell): shell is OrchestrationV2ThreadShell => shell !== null);
    yield* Effect.forEach(
      tasks,
      (task) =>
        (task.archivedAt === null
          ? reconcileActive(task, links, shells)
          : unlinkRevived(task, links, shells)
        ).pipe(
          Effect.catchCause(logSkipped("Work Task reactor skipped a task", { taskId: task.id })),
        ),
      { discard: true },
    );
  });

  const sweep = lock
    .withPermit(pass)
    .pipe(Effect.catchCause(logSkipped("Work Task reactor sweep failed", {})));

  const start = Effect.fn("WorkTaskReactor.start")(function* () {
    // Sliding(1) coalesces bursts of events into one pending sweep.
    const wake = yield* Queue.sliding<void>(1);
    const poke = Queue.offer(wake, undefined).pipe(Effect.asVoid);
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) =>
        TRIGGERS.has(event.type) ? poke : Effect.void,
      ).pipe(Effect.catchCause(logSkipped("Work Task reactor event stream failed", {}))),
    );
    yield* forkParked(
      Stream.runForEach(store.changes, () => poke).pipe(
        Effect.catchCause(logSkipped("Work Task reactor change stream failed", {})),
      ),
    );
    yield* forkParked(Effect.forever(Queue.take(wake).pipe(Effect.andThen(sweep))));
    yield* forkParked(sweep.pipe(Effect.repeat(Schedule.spaced("2 minutes")), Effect.asVoid));
  });

  return WorkTaskReactor.of({ start, sweep });
});

export const layer = Layer.effect(WorkTaskReactor, make);
