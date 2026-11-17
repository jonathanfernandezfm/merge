import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  SourceControlRepositoryError,
  ThreadId,
  WorkTaskId,
  type BranchWorkItems,
  type OrchestrationV2ThreadShell,
  type PullRequestDetail,
  type ThreadPullRequestLink,
  type WorkTask,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { PullRequestService } from "../../pullRequest/PullRequestService.ts";
import * as WorkTaskInsights from "./WorkTaskInsights.ts";
import { WorkTaskStore } from "./WorkTaskStore.ts";

const NOW = "2026-10-01T12:00:00.000Z";
const BRANCH = "feature/123-widgets";

const task = (id: string, overrides: Partial<WorkTask> = {}): WorkTask => ({
  id: WorkTaskId.make(id),
  projectId: ProjectId.make("project-1"),
  title: "Widgets",
  titleSource: "branch",
  description: null,
  workspace: {
    path: `/wt/${id}`,
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

const prLink = (state: "open" | "merged"): ThreadPullRequestLink => ({
  host: "dev.azure.com",
  repository: "acme/app",
  number: 7,
  url: "https://dev.azure.com/acme/app/_git/app/pullrequest/7",
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
  },
});

const workItems: BranchWorkItems = {
  branch: BRANCH,
  supported: true,
  source: "branch-name",
  workItemId: 123,
  root: {
    id: 123,
    title: "Build widgets",
    type: "Product Backlog Item",
    state: "Active",
    parentId: null,
    assignedTo: null,
    url: "https://dev.azure.com/acme/app/_workitems/edit/123",
  },
  rootDetails: {
    descriptionHtml: null,
    criteriaHtml: null,
    criteriaLabel: "Acceptance criteria",
    sprint: "Sprint 4",
    priority: null,
    tags: [],
    createdAt: null,
    updatedAt: null,
    stateChangedAt: null,
  },
  children: [],
  states: {},
};

const down = () =>
  new SourceControlRepositoryError({
    operation: "detail",
    provider: "azure-devops" as never,
    detail: "the host is down",
  });

/** One task with one linked thread whose PR is in `state`; counts every detail call. */
const harness = (options: {
  readonly tasks: ReadonlyArray<WorkTask>;
  readonly prState?: "open" | "merged";
  readonly workItemsFail?: boolean | (() => boolean);
  readonly reviewDecision?: "approved" | "changes-requested";
  readonly provider?: string;
  readonly prFails?: "detail" | "activity";
}) => {
  const calls = { detail: 0, workItems: 0, votes: 0 };
  const shells = new Map(
    options.tasks.map((entry) => [
      `thread-${entry.id}`,
      {
        id: ThreadId.make(`thread-${entry.id}`),
        lineage: {
          rootThreadId: ThreadId.make(`thread-${entry.id}`),
          parentThreadId: null,
          relationshipToParent: null,
        },
        pullRequests: options.prState ? [prLink(options.prState)] : [],
      } as unknown as OrchestrationV2ThreadShell,
    ]),
  );
  const store = Layer.succeed(WorkTaskStore, {
    list: () => Effect.succeed(options.tasks),
    get: (id: WorkTaskId) => Effect.succeed(options.tasks.find((entry) => entry.id === id) ?? null),
    links: () =>
      Effect.succeed(
        options.tasks.map((entry) => ({
          threadId: ThreadId.make(`thread-${entry.id}`),
          taskId: entry.id,
          origin: "initial" as const,
        })),
      ),
    changes: Stream.empty,
  } as never);
  const projections = Layer.succeed(ProjectionStore.ProjectionStoreV2, {
    getThreadShell: (id: ThreadId) => Effect.succeed(shells.get(id) ?? null),
    listActiveSubagentThreadIds: () => Effect.succeed([]),
  } as never);
  const pullRequests = Layer.succeed(PullRequestService, {
    detail: () =>
      Effect.suspend(() => {
        calls.detail++;
        if (options.prFails === "detail") return Effect.fail(down());
        return Effect.succeed({
          provider: options.provider ?? "azure-devops",
          workspaceRoot: "/wt",
          number: 7,
          mergeability: "mergeable",
          checks: [],
        } as unknown as PullRequestDetail);
      }),
    // The held summary: only non-ADO hosts read their decision from it.
    summary: () => Effect.succeed({ reviewDecision: "changes-requested" }),
    activity: () =>
      options.prFails === "activity"
        ? Effect.fail(down())
        : Effect.succeed({ reviewThreads: [], overviewThreads: [] }),
  } as never);
  const service = Layer.effect(
    WorkTaskInsights.WorkTaskInsights,
    WorkTaskInsights.make({
      branchWorkItems: () =>
        Effect.suspend(() => {
          calls.workItems++;
          const fail =
            typeof options.workItemsFail === "function"
              ? options.workItemsFail()
              : options.workItemsFail;
          return fail
            ? Effect.fail(
                new SourceControlRepositoryError({
                  operation: "branchWorkItems",
                  provider: "azure-devops" as never,
                  detail: "az is not logged in",
                }),
              )
            : Effect.succeed(workItems);
        }),
      readReviewDecision: () =>
        Effect.sync(() => {
          calls.votes++;
          return options.reviewDecision ?? "approved";
        }),
    }),
  ).pipe(Layer.provide(Layer.mergeAll(store, projections, pullRequests)));
  return { calls, service };
};

/** Starts the service and runs `passes` once-a-minute passes to completion. */
const tick = (passes = 1) =>
  Effect.gen(function* () {
    const insights = yield* WorkTaskInsights.WorkTaskInsights;
    yield* insights.start();
    for (let i = 0; i < passes; i++) yield* TestClock.adjust("1 minute");
  });

const latest = Effect.flatMap(WorkTaskInsights.WorkTaskInsights, (insights) =>
  Stream.runHead(insights.stream),
).pipe(Effect.map((head) => (head._tag === "Some" ? head.value : null)));

it.effect("an open PR yields facts and a pass within 2 minutes reuses them", () => {
  const { calls, service } = harness({ tasks: [task("a")], prState: "open" });
  return Effect.gen(function* () {
    yield* tick(2);
    const snapshot = yield* latest;
    assert.equal(calls.detail, 1);
    assert.equal(calls.votes, 1);
    const [entry] = snapshot!.insights;
    assert.equal(entry?.pullRequest?.number, 7);
    assert.equal(entry?.pullRequest?.review, "approved");
    assert.deepEqual(entry?.workItem, {
      id: 123,
      title: "Build widgets",
      type: "Product Backlog Item",
      state: "Active",
      sprint: "Sprint 4",
      url: "https://dev.azure.com/acme/app/_workitems/edit/123",
      source: "branch-name",
    });
  }).pipe(Effect.scoped, Effect.provide(service));
});

it.effect("the summary's review decision reaches the facts", () =>
  Effect.forEach(["approved", "changes-requested"] as const, (reviewDecision) => {
    const { service } = harness({ tasks: [task("a")], prState: "open", reviewDecision });
    return Effect.gen(function* () {
      yield* tick();
      const snapshot = yield* latest;
      assert.equal(snapshot!.insights[0]?.pullRequest?.review, reviewDecision);
    }).pipe(Effect.scoped, Effect.provide(service));
  }),
);

it.effect("a non-ADO PR takes the decision from the held summary, without az", () => {
  const { calls, service } = harness({ tasks: [task("a")], prState: "open", provider: "github" });
  return Effect.gen(function* () {
    yield* tick();
    const snapshot = yield* latest;
    assert.equal(snapshot!.insights[0]?.pullRequest?.review, "changes-requested");
    assert.equal(calls.votes, 0);
  }).pipe(Effect.scoped, Effect.provide(service));
});

it.effect("a work item failure gives workItem null and keeps the PR facts", () => {
  const { service } = harness({ tasks: [task("a")], prState: "open", workItemsFail: true });
  return Effect.gen(function* () {
    const insights = yield* WorkTaskInsights.WorkTaskInsights;
    yield* tick();
    const snapshot = yield* latest;
    assert.equal(snapshot!.insights[0]?.workItem, null);
    assert.equal(snapshot!.insights[0]?.pullRequest?.number, 7);
    assert.equal(yield* insights.workItem(WorkTaskId.make("a")), null);
  }).pipe(Effect.scoped, Effect.provide(service));
});

it.effect("a task without a worktree yet is not cached as having no work item", () => {
  const tasks = [task("a", { workspace: { ...task("a").workspace, path: null } })];
  const { calls, service } = harness({ tasks });
  return Effect.gen(function* () {
    const insights = yield* WorkTaskInsights.WorkTaskInsights;
    assert.equal(yield* insights.workItem(WorkTaskId.make("a")), null);
    assert.equal(calls.workItems, 0);
    // Setup set the path.
    tasks[0] = task("a");
    const found = yield* insights.workItem(WorkTaskId.make("a"));
    assert.equal(found?.item.id, 123);
    assert.equal(calls.workItems, 1);
  }).pipe(Effect.scoped, Effect.provide(service));
});

it.effect("an archived task is not in the snapshot", () => {
  const { service } = harness({
    tasks: [task("a"), task("b", { archivedAt: NOW })],
    prState: "open",
  });
  return Effect.gen(function* () {
    yield* tick();
    const snapshot = yield* latest;
    assert.deepEqual(
      snapshot!.insights.map((entry) => entry.taskId),
      [WorkTaskId.make("a")],
    );
  }).pipe(Effect.scoped, Effect.provide(service));
});

it.effect("a merged PR yields pullRequest null", () => {
  const { calls, service } = harness({ tasks: [task("a")], prState: "merged" });
  return Effect.gen(function* () {
    yield* tick();
    const snapshot = yield* latest;
    assert.equal(snapshot!.insights[0]?.pullRequest, null);
    assert.equal(calls.detail, 0);
    assert.equal(calls.votes, 0);
  }).pipe(Effect.scoped, Effect.provide(service));
});

it.effect("a pass that changes nothing, or only syncedAt, sends nothing", () => {
  const { service } = harness({ tasks: [task("a")], prState: "open" });
  return Effect.gen(function* () {
    const insights = yield* WorkTaskInsights.WorkTaskInsights;
    let sent = 0;
    yield* Effect.forkScoped(Stream.runForEach(insights.stream, () => Effect.sync(() => sent++)));
    // Minute 3 re-reads the PR facts, so only syncedAt differs.
    yield* tick(3);
    assert.equal(sent, 2);
  }).pipe(Effect.scoped, Effect.provide(service));
});

it.effect("a failing work item read keeps the last good item", () => {
  let failing = false;
  const { calls, service } = harness({ tasks: [task("a")], workItemsFail: () => failing });
  return Effect.gen(function* () {
    yield* tick();
    failing = true;
    yield* TestClock.adjust("10 minutes");
    assert.equal(calls.workItems, 2);
    const snapshot = yield* latest;
    assert.equal(snapshot!.insights[0]?.workItem?.id, 123);
  }).pipe(Effect.scoped, Effect.provide(service));
});

it.effect("a failing PR read gives pullRequest null and keeps the work item", () =>
  Effect.forEach(["detail", "activity"] as const, (prFails) => {
    const { service } = harness({ tasks: [task("a")], prState: "open", prFails });
    return Effect.gen(function* () {
      yield* tick();
      const snapshot = yield* latest;
      assert.equal(snapshot!.insights[0]?.pullRequest, null);
      assert.equal(snapshot!.insights[0]?.workItem?.id, 123);
    }).pipe(Effect.scoped, Effect.provide(service));
  }),
);
