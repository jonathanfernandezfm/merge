import {
  CommandId,
  workTaskStatusInputs,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type ThreadPullRequestKey,
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
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { PULL_REQUEST_WATCH_WAKE_LIMIT } from "../../orchestration-v2/pullRequestWatch.ts";
import { forkParked } from "../../serverActivation.ts";
import {
  legacyThreadPullRequestKey,
  threadPullRequestKeysEqual,
  threadPullRequestsOf,
  visibleThreadPullRequests,
} from "../../sourceControl/threadPullRequests.ts";
import { WorkTaskStore, type WorkTaskReactorMark } from "./WorkTaskStore.ts";
import { WorkTaskWorkspace, type WorkTaskLauncher } from "./WorkTaskWorkspace.ts";

const REVIEW_THREAD_TITLE = "Review feedback";
const REVIEW_LAUNCHER: WorkTaskLauncher = { createdBy: "system", creationSource: "server" };

/** Events that can change a link, a PR snapshot, or whether a task thread is busy. */
const TRIGGERS: ReadonlySet<OrchestrationV2DomainEvent["type"]> = new Set([
  "thread.pull-request-synced",
  "thread.pull-request-link-updated",
  "thread.archived",
  "run.created",
  "run.updated",
  "runtime-request.updated",
  "subagent.updated",
]);

const isLive = (shell: OrchestrationV2ThreadShell) =>
  shell.archivedAt === null && shell.deletedAt === null;

const keyText = (key: ThreadPullRequestKey) => `${key.host}/${key.repository}#${key.number}`;

/** Logs a failure and lets interrupts through. */
const logSkipped =
  (message: string, fields: Record<string, unknown> = {}) =>
  <E>(cause: Cause.Cause<E>): Effect.Effect<void> =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.interrupt
      : Effect.logWarning(message, { ...fields, cause: Cause.pretty(cause) });

/** Runs a long-lived subscription again 5 s after it fails or ends. */
const restarting = <E, R>(message: string, effect: Effect.Effect<void, E, R>) =>
  Effect.forever(
    effect.pipe(Effect.catchCause(logSkipped(message)), Effect.andThen(Effect.sleep("5 seconds"))),
  );

/**
 * Work Task layer on upstream's PR engine: links branch PRs, stamps `merged_at`, keeps one
 * "Review feedback" thread whose watch is held off while a sibling is busy, and unlinks revived
 * threads of archived tasks. Decisions come from the store and its reactor marks, so restarts are safe.
 */
export class WorkTaskReactor extends Context.Service<
  WorkTaskReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** One full reconcile pass, archived tasks included. Logs failures and never fails. */
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/merge/workTasks/WorkTaskReactor") {}

export const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const store = yield* WorkTaskStore;
  const workspace = yield* WorkTaskWorkspace;
  const crypto = yield* Crypto.Crypto;
  // Event wakes and the timer must not reconcile at once.
  const lock = yield* Semaphore.make(1);
  // Event filter only: threads of active tasks and their subagents, refreshed every pass.
  const relevant = yield* Ref.make<ReadonlySet<string>>(new Set());
  const archivedDue = yield* Ref.make(false);

  const dispatch = (tag: string, command: (commandId: CommandId) => OrchestrationV2ServerCommand) =>
    crypto.randomUUIDv4().pipe(
      Effect.orDie,
      Effect.flatMap((id) =>
        engine.dispatch(command(CommandId.make(`merge:work-task-${tag}:${id}`))),
      ),
    );

  const watchCommand = (
    threadId: OrchestrationV2ThreadShell["id"],
    key: ThreadPullRequestKey,
    watching: boolean,
    extra: { readonly resume?: boolean; readonly url?: string } = {},
  ) =>
    dispatch(watching ? "pr-watch" : "pr-unwatch", (commandId) => ({
      type: "thread.pull-request.watch",
      commandId,
      threadId,
      host: key.host,
      repository: key.repository,
      number: key.number,
      watching,
      ...(extra.resume === true && { resumeRemarksFromEndedWatch: true }),
      // manual: an agent-source watch is refused after the user stopped the thread's last run.
      ...(extra.url !== undefined && { link: { url: extra.url, source: "manual" as const } }),
    }));

  const reconcileActive = Effect.fn("WorkTaskReactor.reconcileActive")(function* (
    task: WorkTask,
    links: ReadonlyArray<WorkTaskLink>,
    marks: ReadonlyMap<string, WorkTaskReactorMark>,
    shells: ReadonlyArray<OrchestrationV2ThreadShell>,
  ) {
    const branch = task.workspace.branch;
    const own = links.filter((link) => link.taskId === task.id);
    const ownIds = new Set<string>(own.map((link) => link.threadId));
    const threads = shells.filter((shell) => ownIds.has(shell.id) && isLive(shell));

    // PR linker: link each thread's branch PR once. The recorded key makes a user unlink stick.
    for (const shell of threads) {
      const found = shell.branchPullRequest;
      if (!found || shell.branch !== branch) continue;
      const key = legacyThreadPullRequestKey(found);
      const text = keyText(key);
      if (marks.get(shell.id)?.autoLinkedPrKey === text) continue;
      if (!threadPullRequestsOf(shell).some((link) => threadPullRequestKeysEqual(link, key))) {
        yield* dispatch("pr-link", (commandId) => ({
          type: "thread.pull-request.link",
          commandId,
          threadId: shell.id,
          ...key,
          url: found.url,
          source: "agent",
        }));
      }
      yield* store.setReactorMark(shell.id, { autoLinkedPrKey: text });
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
    const mark = reviewLink ? (marks.get(reviewLink.threadId)?.reviewWatch ?? null) : null;
    const wanted =
      task.autoHandleReviewFeedback &&
      task.workspace.setup.status === "ready" &&
      pr !== undefined &&
      pr.snapshot?.state === "open";

    if (!wanted) {
      // Auto-handle is off or there is no open PR: the review thread watches nothing.
      if (review === null || !isLive(review)) return;
      const reviewId = review.id;
      const watched = visibleThreadPullRequests(review.pullRequests ?? []).filter(
        (link) => link.watch !== undefined,
      );
      yield* Effect.forEach(watched, (link) => watchCommand(reviewId, link, false), {
        discard: true,
      });
      // Upstream also ends watches on merge or close. Clearing makes the next watch plain.
      if (mark !== null) {
        yield* store.setReactorMark(reviewId, { reviewWatch: null });
      }
      return;
    }

    if (reviewLink === undefined) {
      // No initial message: a retried preparation with one would drop skipSetupScript.
      // A fixed commandId replays the launch receipt if a crash lost the link.
      const { threadId } = yield* workspace.createThread(
        {
          taskId: task.id,
          title: REVIEW_THREAD_TITLE,
          origin: "review-feedback",
          commandId: CommandId.make(`merge:work-task-review:${task.id}`),
        },
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
    const link = threadPullRequestsOf(review).find((entry) =>
      threadPullRequestKeysEqual(entry, key),
    );

    if (link?.watch !== undefined) {
      if (busy) {
        // Marked first: after a crash, `held` with no watch still resumes.
        yield* store.setReactorMark(review.id, { reviewWatch: "held" });
        yield* watchCommand(review.id, key, false);
      } else if (mark !== "on") {
        yield* store.setReactorMark(review.id, { reviewWatch: "on" });
      }
      return;
    }
    // Off, and `on`: an agent's unwatch or upstream ending the watch. Respect it.
    if (busy || mark === "on") return;
    if (mark === "held") {
      // A hold never revives a watch upstream ended at its comment-only limit.
      if ((link?.endedWatch?.wakes ?? 0) >= PULL_REQUEST_WATCH_WAKE_LIMIT) {
        yield* store.setReactorMark(review.id, { reviewWatch: "on" });
        return;
      }
      yield* watchCommand(review.id, key, true, { resume: true, url: pr.url });
    } else {
      yield* watchCommand(review.id, key, true, { url: pr.url });
    }
    yield* store.setReactorMark(review.id, { reviewWatch: "on" });
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

  const pass = Effect.fn("WorkTaskReactor.pass")(function* (includeArchived: boolean) {
    const tasks = (yield* store.list()).filter(
      (task) => includeArchived || task.archivedAt === null,
    );
    const included = new Set<string>(tasks.map((task) => task.id));
    const links = (yield* store.links()).filter((link) => included.has(link.taskId));
    const marks = new Map((yield* store.reactorMarks()).map((mark) => [mark.threadId, mark]));
    const active = new Set<string>(
      tasks.filter((task) => task.archivedAt === null).map((task) => task.id),
    );
    const activeIds = new Set<string>(
      links.filter((link) => active.has(link.taskId)).map((link) => link.threadId),
    );
    // Subagent children count toward their root's busy state.
    const subagents = yield* Effect.forEach(
      yield* projections.listActiveSubagentThreadIds(),
      (id) => projections.getThreadShell(id),
      { concurrency: 8 },
    );
    const children = subagents.filter(
      (shell): shell is OrchestrationV2ThreadShell =>
        shell !== null && activeIds.has(shell.lineage.rootThreadId) && !activeIds.has(shell.id),
    );
    const linkedShells = yield* Effect.forEach(
      links,
      (link) => projections.getThreadShell(link.threadId),
      { concurrency: 8 },
    );
    const shells = [
      ...linkedShells.filter((shell): shell is OrchestrationV2ThreadShell => shell !== null),
      ...children,
    ];
    yield* Ref.set(relevant, new Set([...activeIds, ...children.map((shell) => shell.id)]));
    yield* Effect.forEach(
      tasks,
      (task) =>
        (task.archivedAt === null
          ? reconcileActive(task, links, marks, shells)
          : unlinkRevived(task, links, shells)
        ).pipe(
          Effect.catchCause(logSkipped("Work Task reactor skipped a task", { taskId: task.id })),
        ),
      { discard: true },
    );
  });

  const sweepWith = (includeArchived: boolean) =>
    lock
      .withPermit(pass(includeArchived))
      .pipe(Effect.catchCause(logSkipped("Work Task reactor sweep failed")));

  const start = Effect.fn("WorkTaskReactor.start")(function* () {
    // Sliding(1) plus the debounce below coalesces bursts into one sweep.
    const wake = yield* Queue.sliding<void>(1);
    const poke = Queue.offer(wake, undefined).pipe(Effect.asVoid);
    yield* forkParked(
      restarting(
        "Work Task reactor event stream failed",
        Stream.runForEach(engine.streamDomainEvents, (event) => {
          if (event.type === "thread.unarchived") {
            return Ref.set(archivedDue, true).pipe(Effect.andThen(poke));
          }
          if (!TRIGGERS.has(event.type)) return Effect.void;
          return Ref.get(relevant).pipe(
            Effect.flatMap((ids) => (ids.has(event.threadId) ? poke : Effect.void)),
          );
        }),
      ),
    );
    yield* forkParked(
      restarting(
        "Work Task reactor change stream failed",
        Stream.runForEach(store.changes, () => poke),
      ),
    );
    yield* forkParked(
      Effect.forever(
        Queue.take(wake).pipe(
          Effect.andThen(Effect.sleep("1 second")),
          Effect.andThen(Ref.getAndSet(archivedDue, false)),
          Effect.flatMap(sweepWith),
        ),
      ),
    );
    yield* forkParked(
      sweepWith(true).pipe(Effect.repeat(Schedule.spaced("2 minutes")), Effect.asVoid),
    );
  });

  return WorkTaskReactor.of({ start, sweep: sweepWith(true) });
});

export const layer = Layer.effect(WorkTaskReactor, make);
