import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkTaskId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type ThreadPullRequestLink,
  type WorkTask,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as WorkTaskReactor from "./WorkTaskReactor.ts";
import * as WorkTaskStore from "./WorkTaskStore.ts";
import * as WorkTaskWorkspace from "./WorkTaskWorkspace.ts";

const NOW = "2026-10-01T12:00:00.000Z";
const BRANCH = "feature/widgets";
const PR_URL = "https://github.com/acme/app/pull/7";
const instance = ProviderInstanceId.make("codex");
const TASK = WorkTaskId.make("task-1");

const shell = (
  id: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  id: ThreadId.make(id),
  projectId: ProjectId.make("project-1"),
  title: id,
  providerInstanceId: instance,
  modelSelection: { instanceId: instance, model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: BRANCH,
  worktreePath: "/wt",
  activeProviderThreadId: null,
  lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  latestRunId: null,
  activeRunId: null,
  status: "idle",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  pendingBackgroundTasks: [],
  providerInstanceHistory: [],
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: DateTime.makeUnsafe(NOW),
  updatedAt: DateTime.makeUnsafe(NOW),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  ...overrides,
});

const prLink = (
  state: "open" | "merged",
  mergedAt: string | null = null,
): ThreadPullRequestLink => ({
  host: "github.com",
  repository: "acme/app",
  number: 7,
  url: PR_URL,
  source: "agent",
  linkedAt: NOW,
  stack: null,
  snapshot: {
    state,
    title: "Widgets",
    headBranch: BRANCH,
    baseBranch: "main",
    isDraft: false,
    updatedAt: NOW,
    syncedAt: NOW,
    mergedAt,
  },
});

const workTask = (overrides: Partial<WorkTask> = {}): WorkTask => ({
  id: TASK,
  projectId: ProjectId.make("project-1"),
  title: "Widgets",
  description: null,
  workspace: {
    path: "/wt",
    branch: BRANCH,
    remoteName: "origin",
    remoteBranch: BRANCH,
    baseBranch: "main",
    setup: { status: "ready", steps: [], error: null, updatedAt: NOW },
  },
  legacyPullRequest: null,
  autoHandleReviewFeedback: false,
  waitingForUserReason: null,
  createdAt: NOW,
  updatedAt: NOW,
  mergedAt: null,
  archivedAt: null,
  deletedAt: null,
  ...overrides,
});

const shells = new Map<string, OrchestrationV2ThreadShell>();
const commands: Array<OrchestrationV2ServerCommand> = [];
const created: Array<WorkTaskWorkspace.WorkTaskCreateThreadOptions> = [];
const reads: Array<string> = [];
let events: Queue.Queue<OrchestrationV2DomainEvent> | null = null;

const put = (value: OrchestrationV2ThreadShell) => shells.set(value.id, value);
const patch = (id: string, overrides: Partial<OrchestrationV2ThreadShell>) =>
  put({ ...shells.get(id)!, ...overrides });

/** Applies link and watch commands to the fake shells, as the decider would. */
const apply = (command: OrchestrationV2ServerCommand) => {
  if (command.type === "thread.pull-request.link") {
    const { host, repository, number, url, source } = command;
    const target = shells.get(command.threadId)!;
    patch(command.threadId, {
      pullRequests: [
        ...(target.pullRequests ?? []),
        { host, repository, number, url, source, linkedAt: NOW, snapshot: null, stack: null },
      ],
    });
  }
  if (command.type === "thread.pull-request.watch") {
    const target = shells.get(command.threadId)!;
    const existing = target.pullRequests?.find((link) => link.number === command.number);
    const base = existing ?? { ...prLink("open"), source: "manual" as const };
    const watch = {
      startedAt: NOW,
      headSha: null,
      failedChecks: [],
      passed: false,
      passedChecks: [],
      remarksThrough: NOW,
      remarkIds: [],
      conflicting: false,
      wakes: 0,
    };
    const { watch: previous, endedWatch, ...rest } = base;
    const resumed = command.resumeRemarksFromEndedWatch && endedWatch;
    const next = command.watching
      ? { ...rest, watch: previous ?? { ...watch, ...(resumed && { wakes: endedWatch.wakes }) } }
      : { ...rest, ...((previous ?? endedWatch) && { endedWatch: previous ?? endedWatch }) };
    patch(command.threadId, {
      pullRequests: [
        ...(target.pullRequests ?? []).filter((link) => link.number !== command.number),
        next,
      ],
    });
  }
};

const layerStore = WorkTaskStore.layer.pipe(
  Layer.provideMerge(
    Layer.effectDiscard(runMigrations()).pipe(
      Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const layerFakes = Layer.mergeAll(
  Layer.mock(ProjectionStore.ProjectionStoreV2)({
    getThreadShell: (threadId) =>
      Effect.sync(() => {
        reads.push(threadId);
        return shells.get(threadId) ?? null;
      }),
    listActiveSubagentThreadIds: () =>
      Effect.succeed(
        [...shells.values()]
          .filter((value) => value.lineage.relationshipToParent === "subagent")
          .map((value) => value.id),
      ),
  }),
  Layer.mock(Orchestrator.OrchestratorV2)({
    streamDomainEvents: Stream.unwrap(
      Effect.sync(() => (events === null ? Stream.empty : Stream.fromQueue(events))),
    ),
    dispatch: (command) =>
      Effect.sync(() => {
        if ("threadId" in command && command.threadId === "explode") throw new Error("boom");
        commands.push(command);
        apply(command);
        return { sequence: commands.length, storedEvents: [] };
      }),
  }),
  Layer.effect(
    WorkTaskWorkspace.WorkTaskWorkspace,
    Effect.gen(function* () {
      const store = yield* WorkTaskStore.WorkTaskStore;
      const service: Partial<WorkTaskWorkspace.WorkTaskWorkspace["Service"]> = {
        createThread: (input) =>
          Effect.gen(function* () {
            created.push(input);
            const threadId = ThreadId.make(`review-${created.length}`);
            put(shell(threadId));
            yield* store.link(threadId, input.taskId, input.origin ?? "user");
            return { threadId };
          }),
      };
      return service as WorkTaskWorkspace.WorkTaskWorkspace["Service"];
    }),
  ),
);

const layer = Layer.mergeAll(layerFakes).pipe(Layer.provideMerge(layerStore));

/** A fresh reactor each time: it must behave the same after a restart. */
const sweep = Effect.flatMap(WorkTaskReactor.make, (reactor) => reactor.sweep);

const setup = Effect.fn("setup")(function* (task: Partial<WorkTask> = {}) {
  shells.clear();
  commands.length = 0;
  created.length = 0;
  reads.length = 0;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM merge_thread_links`;
  yield* sql`DELETE FROM projection_tasks`;
  const store = yield* WorkTaskStore.WorkTaskStore;
  yield* store.insert(workTask(task));
  return store;
});

const watches = () => commands.filter((command) => command.type === "thread.pull-request.watch");

it.layer(layer)("WorkTaskReactor", (it) => {
  it.effect("links a task thread's branch PR once, and a user unlink sticks", () =>
    Effect.gen(function* () {
      const store = yield* setup();
      const branchPullRequest = {
        projectId: ProjectId.make("project-1"),
        repository: "acme/app",
        number: 7,
        url: PR_URL,
      };
      put(shell("thread-1", { branchPullRequest }));
      put(shell("other-branch", { branch: "main", branchPullRequest }));
      yield* store.link(ThreadId.make("thread-1"), TASK, "user");
      yield* store.link(ThreadId.make("other-branch"), TASK, "user");

      yield* sweep;
      yield* sweep;
      // The user unlinks it: that sticks, across a restart too.
      patch("thread-1", { pullRequests: [] });
      yield* sweep;

      const links = commands.filter((command) => command.type === "thread.pull-request.link");
      assert.deepEqual(
        links.map((command) => [command.threadId, command.number, command.source]),
        [["thread-1", 7, "agent"]],
      );
    }),
  );

  it.effect("stamps merged_at from a merged snapshot", () =>
    Effect.gen(function* () {
      const store = yield* setup();
      put(shell("thread-1", { pullRequests: [prLink("merged", "2026-10-02T09:00:00.000Z")] }));
      yield* store.link(ThreadId.make("thread-1"), TASK, "user");

      yield* sweep;

      assert.equal((yield* store.get(TASK))?.mergedAt, "2026-10-02T09:00:00.000Z");
    }),
  );

  it.effect("auto-handle creates one review thread and watches it, across restarts", () =>
    Effect.gen(function* () {
      const store = yield* setup({ autoHandleReviewFeedback: true });
      put(shell("thread-1", { pullRequests: [prLink("open")] }));
      yield* store.link(ThreadId.make("thread-1"), TASK, "user");

      yield* sweep;
      yield* sweep;
      yield* sweep;

      // No initial message; a fixed commandId makes the launch replayable.
      assert.deepEqual(created, [
        {
          taskId: TASK,
          title: "Review feedback",
          origin: "review-feedback",
          commandId: CommandId.make(`merge:work-task-review:${TASK}`),
        },
      ]);
      assert.deepEqual(
        (yield* store.links()).filter((link) => link.origin === "review-feedback"),
        [{ threadId: ThreadId.make("review-1"), taskId: TASK, origin: "review-feedback" }],
      );
      assert.equal(watches().length, 1);
      const [watch] = watches();
      assert.include(watch, {
        threadId: ThreadId.make("review-1"),
        number: 7,
        watching: true,
      });
      // The first watch is plain: it starts a new baseline.
      assert.isUndefined(watch?.resumeRemarksFromEndedWatch);
    }),
  );

  it.effect("holds the review watch while any sibling is busy and resumes when all are idle", () =>
    Effect.gen(function* () {
      const store = yield* setup({ autoHandleReviewFeedback: true });
      put(shell("thread-1", { pullRequests: [prLink("open")] }));
      put(shell("thread-2"));
      yield* store.link(ThreadId.make("thread-1"), TASK, "user");
      yield* store.link(ThreadId.make("thread-2"), TASK, "user");
      yield* sweep;
      const watching = () =>
        shells.get("review-1")?.pullRequests?.find((link) => link.number === 7)?.watch !==
        undefined;
      assert.isTrue(watching());

      const busyStates: Array<[string, Partial<OrchestrationV2ThreadShell>]> = [
        ["running", { status: "running" }],
        [
          "waiting",
          {
            pendingRuntimeRequest: {
              requestId: "request-1",
              kind: "approval",
              blocking: true,
            } as unknown as OrchestrationV2ThreadShell["pendingRuntimeRequest"],
          },
        ],
        [
          "monitoring",
          {
            pendingBackgroundTasks: [
              {},
            ] as unknown as OrchestrationV2ThreadShell["pendingBackgroundTasks"],
          },
        ],
      ];
      for (const [label, busy] of busyStates) {
        patch("thread-2", busy);
        yield* sweep;
        assert.isFalse(watching(), `${label} sibling holds the watch`);
        yield* sweep;
        assert.isFalse(watching(), `${label} sibling still holds it`);
        put(shell("thread-2"));
        yield* sweep;
        assert.isTrue(watching(), `idle after ${label} resumes the watch`);
      }

      // A running subagent child of a sibling holds it too.
      put(
        shell("child", {
          status: "running",
          lineage: {
            rootThreadId: ThreadId.make("thread-2"),
            parentThreadId: ThreadId.make("thread-2"),
            relationshipToParent: "subagent",
          },
        }),
      );
      yield* sweep;
      assert.isFalse(watching());
      shells.delete("child");

      // The review thread's own run never holds itself.
      patch("review-1", { status: "running" });
      yield* sweep;
      assert.isTrue(watching());

      // Only resumes from a hold carry the flag; the first watch does not.
      const [first, ...resumed] = watches().filter((command) => command.watching);
      assert.isUndefined(first?.resumeRemarksFromEndedWatch);
      assert.lengthOf(resumed, 4);
      assert.isTrue(resumed.every((command) => command.resumeRemarksFromEndedWatch === true));
    }),
  );

  it.effect("turning auto-handle off unwatches", () =>
    Effect.gen(function* () {
      const store = yield* setup({ autoHandleReviewFeedback: true });
      put(shell("thread-1", { pullRequests: [prLink("open")] }));
      yield* store.link(ThreadId.make("thread-1"), TASK, "user");
      yield* sweep;

      yield* store.update(TASK, { autoHandleReviewFeedback: false });
      yield* sweep;
      yield* sweep;

      assert.deepEqual(
        watches().map((command) => command.watching),
        [true, false],
      );
      assert.equal(created.length, 1);
    }),
  );

  it.effect("respects an agent's unwatch until auto-handle is toggled, then watches plainly", () =>
    Effect.gen(function* () {
      const store = yield* setup({ autoHandleReviewFeedback: true });
      put(shell("thread-1", { pullRequests: [prLink("open")] }));
      yield* store.link(ThreadId.make("thread-1"), TASK, "user");
      yield* sweep;
      // The agent hands back with unwatch_pull_request.
      apply({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("agent-unwatch"),
        threadId: ThreadId.make("review-1"),
        host: "github.com",
        repository: "acme/app",
        number: 7,
        watching: false,
      });
      yield* sweep;
      yield* sweep;
      assert.deepEqual(
        watches().map((command) => command.watching),
        [true],
      );

      yield* store.update(TASK, { autoHandleReviewFeedback: false });
      yield* sweep;
      yield* store.update(TASK, { autoHandleReviewFeedback: true });
      yield* sweep;
      assert.deepEqual(
        watches().map((command) => [command.watching, command.resumeRemarksFromEndedWatch]),
        [
          [true, undefined],
          [true, undefined],
        ],
      );
    }),
  );

  it.effect("a new PR after the old one closed gets a plain watch", () =>
    Effect.gen(function* () {
      const store = yield* setup({ autoHandleReviewFeedback: true });
      put(shell("thread-1", { pullRequests: [prLink("open")] }));
      yield* store.link(ThreadId.make("thread-1"), TASK, "user");
      yield* sweep;
      // The PR closes and upstream ends the review thread's watch itself.
      const closed = {
        ...prLink("open"),
        snapshot: { ...prLink("open").snapshot!, state: "closed" as const },
      };
      patch("thread-1", { pullRequests: [closed] });
      patch("review-1", {
        pullRequests: shells.get("review-1")!.pullRequests!.map(({ watch, ...link }) => ({
          ...link,
          snapshot: closed.snapshot,
          ...(watch && { endedWatch: watch }),
        })),
      });
      yield* sweep;
      // A new PR opens on the branch.
      patch("thread-1", {
        pullRequests: [
          closed,
          {
            ...prLink("open"),
            number: 8,
            url: `${PR_URL.slice(0, -1)}8`,
            linkedAt: "2026-10-02T00:00:00.000Z",
          },
        ],
      });
      yield* sweep;

      assert.deepEqual(
        watches().map((command) => [
          command.number,
          command.watching,
          command.resumeRemarksFromEndedWatch,
        ]),
        [
          [7, true, undefined],
          [8, true, undefined],
        ],
      );
    }),
  );

  it.effect("re-linking a thread to another task resets its reactor marks", () =>
    Effect.gen(function* () {
      const store = yield* setup();
      const threadId = ThreadId.make("thread-1");
      yield* store.link(threadId, TASK, "review-feedback");
      yield* store.setReactorMark(threadId, {
        autoLinkedPrKey: "github.com/acme/app#7",
        reviewWatch: "on",
      });
      const marks = Effect.map(store.reactorMarks(), (all) =>
        all.find((mark) => mark.threadId === threadId),
      );

      yield* store.link(threadId, TASK, "review-feedback");
      assert.deepEqual(yield* marks, {
        threadId,
        autoLinkedPrKey: "github.com/acme/app#7",
        reviewWatch: "on",
      });

      yield* store.link(threadId, WorkTaskId.make("task-2"), "user");
      assert.deepEqual(yield* marks, { threadId, autoLinkedPrKey: null, reviewWatch: null });
    }),
  );

  it.effect("a hold never revives a watch at the comment-only wake limit", () =>
    Effect.gen(function* () {
      const store = yield* setup({ autoHandleReviewFeedback: true });
      put(shell("thread-1", { pullRequests: [prLink("open")] }));
      put(shell("thread-2"));
      yield* store.link(ThreadId.make("thread-1"), TASK, "user");
      yield* store.link(ThreadId.make("thread-2"), TASK, "user");
      yield* sweep;
      patch("thread-2", { status: "running" });
      yield* sweep;
      // The ended watch is at the limit.
      const review = shells.get("review-1")!;
      patch("review-1", {
        pullRequests: review.pullRequests!.map((link) =>
          link.endedWatch ? { ...link, endedWatch: { ...link.endedWatch, wakes: 10 } } : link,
        ),
      });
      put(shell("thread-2"));
      yield* sweep;
      yield* sweep;

      assert.deepEqual(
        watches().map((command) => command.watching),
        [true, false],
      );
    }),
  );

  it.effect("unlinks an unarchived thread of an archived task", () =>
    Effect.gen(function* () {
      const store = yield* setup({ archivedAt: NOW });
      put(shell("revived"));
      put(shell("archived", { archivedAt: DateTime.makeUnsafe(NOW) }));
      yield* store.link(ThreadId.make("revived"), TASK, "user");
      yield* store.link(ThreadId.make("archived"), TASK, "user");

      yield* sweep;

      assert.deepEqual(
        (yield* store.links()).map((link) => link.threadId),
        [ThreadId.make("archived")],
      );
    }),
  );

  it.effect("a failing task is logged and the others still reconcile", () =>
    Effect.gen(function* () {
      const store = yield* setup();
      yield* store.insert(workTask({ id: WorkTaskId.make("task-2") }));
      // task-1's link dispatch dies.
      put(
        shell("explode", {
          branchPullRequest: {
            projectId: ProjectId.make("project-1"),
            repository: "acme/app",
            number: 7,
            url: PR_URL,
          },
        }),
      );
      put(shell("thread-2", { pullRequests: [prLink("merged", "2026-10-03T00:00:00.000Z")] }));
      yield* store.link(ThreadId.make("explode"), TASK, "user");
      yield* store.link(ThreadId.make("thread-2"), WorkTaskId.make("task-2"), "user");

      yield* sweep;

      assert.equal(
        (yield* store.get(WorkTaskId.make("task-2")))?.mergedAt,
        "2026-10-03T00:00:00.000Z",
      );
    }),
  );

  it.effect("events: only task threads wake it, and archived tasks are read on unarchive", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* setup({ archivedAt: NOW });
        yield* store.insert(workTask({ id: WorkTaskId.make("task-2") }));
        put(shell("thread-2"));
        put(shell("revived"));
        yield* store.link(ThreadId.make("thread-2"), WorkTaskId.make("task-2"), "user");
        events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
        const queue = events;
        const emit = (type: string, threadId: string) =>
          Queue.offer(queue, { type, threadId } as unknown as OrchestrationV2DomainEvent);
        const settle = Effect.gen(function* () {
          for (let step = 0; step < 5; step += 1) {
            yield* Effect.yieldNow;
            yield* TestClock.adjust("1 second");
          }
        });
        const reactor = yield* WorkTaskReactor.make;
        yield* reactor.start();
        yield* settle;
        // The startup timer pass read everything; later passes are event-driven.
        yield* store.link(ThreadId.make("revived"), TASK, "user");
        yield* settle;
        reads.length = 0;

        yield* emit("run.updated", "stranger");
        yield* settle;
        assert.deepEqual(reads, [], "an unrelated thread does not wake the reactor");

        yield* emit("run.updated", "thread-2");
        yield* settle;
        assert.include(reads, "thread-2");
        assert.notInclude(reads, "revived", "archived tasks wait for an unarchive");
        assert.include(
          (yield* store.links()).map((link) => link.threadId),
          ThreadId.make("revived"),
        );

        yield* emit("thread.unarchived", "revived");
        yield* settle;
        assert.notInclude(
          (yield* store.links()).map((link) => link.threadId),
          ThreadId.make("revived"),
        );
        events = null;
      }),
    ),
  );
});
