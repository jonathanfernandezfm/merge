import {
  workTaskPullRequestLink,
  type OrchestrationV2ThreadShell,
  type WorkItem,
  type WorkItemDetails,
  type WorkTask,
  type WorkTaskId,
  type WorkTaskInsightsSnapshot,
  type WorkTaskLink,
  type WorkTaskPullRequestFacts,
  type WorkTaskWorkItem,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { PullRequestService } from "../../pullRequest/PullRequestService.ts";
import { forkParked } from "../../serverActivation.ts";
import { branchWorkItems } from "../workItems/workItems.ts";
import { pullRequestFacts } from "./pullRequestFacts.ts";
import { WorkTaskStore } from "./WorkTaskStore.ts";

const WORK_ITEM_TTL_MS = 10 * 60_000;
const PULL_REQUEST_TTL_MS = 2 * 60_000;
const LOG_TTL_MS = 10 * 60_000;

interface WorkItemEntry {
  readonly item: WorkItem;
  readonly details: WorkItemDetails | null;
  readonly source: WorkTaskWorkItem["source"];
}

interface Cached<A> {
  readonly at: number;
  readonly value: A;
}

/**
 * The ADO work item and PR review facts of each active Work Task. Failures give `null` for that
 * part and never fail the stream, so a repo without `az` simply shows no insights.
 */
export class WorkTaskInsights extends Context.Service<
  WorkTaskInsights,
  {
    /** The latest snapshot first, then each new one. */
    readonly stream: Stream.Stream<WorkTaskInsightsSnapshot>;
    /** Re-reads the task's work item now; PR facts still keep their 2-minute cache. */
    readonly refresh: (taskId: WorkTaskId) => Effect.Effect<void>;
    readonly workItem: (taskId: WorkTaskId) => Effect.Effect<{
      readonly item: WorkItem;
      readonly details: WorkItemDetails | null;
    } | null>;
    /** Refreshes on every Work Task change and once a minute. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/merge/workTasks/WorkTaskInsights") {}

export const make = Effect.fn("WorkTaskInsights.make")(function* (
  deps: { readonly branchWorkItems?: typeof branchWorkItems } = {},
) {
  const readWorkItems = deps.branchWorkItems ?? branchWorkItems;
  const store = yield* WorkTaskStore;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const pullRequests = yield* PullRequestService;
  const snapshot = yield* SubscriptionRef.make<WorkTaskInsightsSnapshot>({ insights: [] });
  // The change stream, the tick and `refresh` must not run passes at once.
  const lock = yield* Semaphore.make(1);
  const workItems = new Map<string, Cached<WorkItemEntry | null>>();
  const facts = new Map<string, Cached<WorkTaskPullRequestFacts | null>>();
  const logged = new Map<string, number>();

  const cached = Effect.fn("WorkTaskInsights.cached")(function* <A>(
    cache: Map<string, Cached<A>>,
    key: string,
    ttl: number,
    load: Effect.Effect<A>,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const hit = cache.get(key);
    if (hit !== undefined && now - hit.at < ttl) return hit.value;
    const value = yield* load;
    cache.set(key, { at: now, value });
    return value;
  });

  /** `null` for the failed part, logged at debug once per task per 10 minutes. */
  const orNull =
    (taskId: WorkTaskId, what: string) =>
    <E>(cause: Cause.Cause<E>): Effect.Effect<null> =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            if (now - (logged.get(taskId) ?? -Infinity) >= LOG_TTL_MS) {
              logged.set(taskId, now);
              yield* Effect.logDebug(`Work Task insights: no ${what}`, {
                taskId,
                cause: Cause.pretty(cause),
              });
            }
            return null;
          });

  const loadWorkItem = (task: WorkTask) =>
    cached(
      workItems,
      task.id,
      WORK_ITEM_TTL_MS,
      task.workspace.path === null
        ? Effect.succeed(null)
        : readWorkItems({ cwd: task.workspace.path }).pipe(
            Effect.map(({ root, rootDetails, source }) =>
              root === null || source === null
                ? null
                : { item: root, details: rootDetails, source },
            ),
            Effect.catchCause(orNull(task.id, "work item")),
          ),
    );

  const loadFacts = (
    task: WorkTask,
    links: ReadonlyArray<WorkTaskLink>,
    shells: ReadonlyArray<OrchestrationV2ThreadShell>,
  ) => {
    const link = workTaskPullRequestLink({ taskId: task.id, task, links, shells });
    if (link?.snapshot?.state !== "open") return Effect.succeed(null);
    const ref = {
      projectId: task.projectId,
      host: link.host,
      repository: link.repository,
      number: link.number,
    };
    return cached(
      facts,
      `${link.host}/${link.repository}#${link.number}`,
      PULL_REQUEST_TTL_MS,
      Effect.all([pullRequests.detail(ref), pullRequests.activity(ref), DateTime.now], {
        concurrency: "unbounded",
      }).pipe(
        Effect.map(([detail, activity, now]) =>
          pullRequestFacts(detail, activity, DateTime.formatIso(now)),
        ),
        Effect.catchCause(orNull(task.id, "pull request facts")),
      ),
    );
  };

  /** Linked threads plus the active subagent threads under them, as status counts them. */
  const readShells = Effect.fn("WorkTaskInsights.readShells")(function* (
    links: ReadonlyArray<WorkTaskLink>,
  ) {
    const ids = new Set<string>(links.map((link) => link.threadId));
    const subagentIds = (yield* projections.listActiveSubagentThreadIds()).filter(
      (id) => !ids.has(id),
    );
    const read = yield* Effect.forEach(
      [...links.map((link) => link.threadId), ...subagentIds],
      (id) => projections.getThreadShell(id),
      { concurrency: 8 },
    );
    return read.filter(
      (shell): shell is OrchestrationV2ThreadShell =>
        shell !== null && (ids.has(shell.id) || ids.has(shell.lineage.rootThreadId)),
    );
  });

  const toWorkTaskWorkItem = (entry: WorkItemEntry | null): WorkTaskWorkItem | null =>
    entry === null
      ? null
      : {
          id: entry.item.id,
          title: entry.item.title,
          type: entry.item.type ?? "",
          state: entry.item.state ?? "",
          sprint: entry.details?.sprint ?? null,
          url: entry.item.url,
          source: entry.source,
        };

  const pass = lock
    .withPermit(
      Effect.gen(function* () {
        const tasks = (yield* store.list()).filter((task) => task.archivedAt === null);
        const active = new Set<string>(tasks.map((task) => task.id));
        const links = (yield* store.links()).filter((link) => active.has(link.taskId));
        const shells = yield* readShells(links);
        const insights = yield* Effect.forEach(
          tasks,
          (task) =>
            Effect.all({
              workItem: loadWorkItem(task).pipe(Effect.map(toWorkTaskWorkItem)),
              pullRequest: loadFacts(task, links, shells),
            }).pipe(Effect.map((parts) => ({ taskId: task.id, ...parts }))),
          { concurrency: 4 },
        );
        yield* SubscriptionRef.set(snapshot, { insights });
      }),
    )
    .pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Work Task insights pass failed", { cause: Cause.pretty(cause) }),
      ),
    );

  const start = Effect.fn("WorkTaskInsights.start")(function* () {
    yield* forkParked(Stream.runForEach(store.changes, () => pass));
    yield* forkParked(Effect.forever(Effect.sleep("1 minute").pipe(Effect.andThen(pass))));
  });

  const refresh = Effect.fn("WorkTaskInsights.refresh")(function* (taskId: WorkTaskId) {
    workItems.delete(taskId);
    yield* pass;
  });

  const workItem = Effect.fn("WorkTaskInsights.workItem")(function* (taskId: WorkTaskId) {
    const task = yield* store.get(taskId).pipe(Effect.catchCause(orNull(taskId, "work task")));
    if (task === null || task.archivedAt !== null) return null;
    const entry = yield* loadWorkItem(task);
    return entry === null ? null : { item: entry.item, details: entry.details };
  });

  return WorkTaskInsights.of({
    stream: SubscriptionRef.changes(snapshot),
    refresh,
    workItem,
    start,
  });
});

export const layer = Layer.effect(WorkTaskInsights, make());
