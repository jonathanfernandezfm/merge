import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkTaskId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type ThreadPullRequestLink,
  type WorkTask,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
    const { watch: previous, ...rest } = base;
    const next = command.watching
      ? { ...rest, watch }
      : { ...rest, ...(previous && { endedWatch: previous }) };
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
    getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
    listActiveSubagentThreadIds: () =>
      Effect.succeed(
        [...shells.values()]
          .filter((value) => value.lineage.relationshipToParent === "subagent")
          .map((value) => value.id),
      ),
  }),
  Layer.mock(Orchestrator.OrchestratorV2)({
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
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM merge_thread_links`;
  yield* sql`DELETE FROM projection_tasks`;
  const store = yield* WorkTaskStore.WorkTaskStore;
  yield* store.insert(workTask(task));
  return store;
});

const watches = () => commands.filter((command) => command.type === "thread.pull-request.watch");

it.layer(layer)("WorkTaskReactor", (it) => {
  it.effect("links a task thread's branch PR once", () =>
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

      // No initial message: only the task, title and origin.
      assert.deepEqual(created, [
        { taskId: TASK, title: "Review feedback", origin: "review-feedback" },
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
        resumeRemarksFromEndedWatch: true,
      });
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

      const resumed = watches().filter((command) => command.watching);
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
});
