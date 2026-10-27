// @effect-diagnostics nodeBuiltinImport:off - fixture repo setup runs outside Effect.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkTaskId,
  type OrchestrationV2ThreadShell,
  type WorkTask,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as WorkTaskStore from "./WorkTaskStore.ts";
import * as WorkTaskWorkspace from "./WorkTaskWorkspace.ts";

const NOW = "2026-10-01T12:00:00.000Z";
const instance = ProviderInstanceId.make("codex");

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
  branch: null,
  worktreePath: null,
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

const workTask = (path: string, overrides: Partial<WorkTask> = {}): WorkTask => ({
  id: WorkTaskId.make("task-1"),
  projectId: ProjectId.make("project-1"),
  title: "Widgets",
  description: null,
  workspace: {
    path,
    branch: "feature/widgets",
    remoteName: "origin",
    remoteBranch: "feature/widgets",
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

/** A clone of a bare remote, on `feature/widgets` tracking `origin/feature/widgets`. */
const pushedClone = () => {
  const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "merge-wt-")));
  const run = (cwd: string, ...args: string[]) =>
    NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
  const remote = NodePath.join(root, "remote.git");
  const clone = NodePath.join(root, "clone");
  NodeChildProcess.execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  NodeChildProcess.execFileSync("git", ["clone", "-q", remote, clone], { stdio: "ignore" });
  run(clone, "config", "user.email", "t@t.com");
  run(clone, "config", "user.name", "T");
  run(clone, "checkout", "-q", "-b", "feature/widgets");
  run(clone, "commit", "-q", "--allow-empty", "-m", "root");
  run(clone, "push", "-q", "-u", "origin", "feature/widgets");
  return { root, clone, run: (...args: string[]) => run(clone, ...args) };
};

const shells = new Map<string, OrchestrationV2ThreadShell>();

const layer = WorkTaskWorkspace.layer.pipe(
  Layer.provideMerge(WorkTaskStore.layer),
  Layer.provideMerge(
    Layer.effectDiscard(runMigrations()).pipe(
      Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
    ),
  ),
  Layer.provide(
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
    }),
  ),
  Layer.provide(
    GitVcsDriver.layer.pipe(
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-work-tasks-test-" })),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("archiveCheck reports each blocker", () =>
  Effect.gen(function* () {
    const store = yield* WorkTaskStore.WorkTaskStore;
    const workspace = yield* WorkTaskWorkspace.WorkTaskWorkspace;
    const repo = pushedClone();
    const taskId = WorkTaskId.make("task-1");
    const check = () => workspace.archiveCheck(taskId).pipe(Effect.map((r) => r.blockers));

    assert.strictEqual((yield* Effect.flip(workspace.archiveCheck(taskId))).reason, "not-found");
    yield* store.insert(workTask(repo.clone));
    assert.deepStrictEqual(yield* check(), []);

    NodeFS.writeFileSync(NodePath.join(repo.clone, "dirty.txt"), "x");
    assert.deepStrictEqual(yield* check(), ["uncommitted-changes"]);
    repo.run("add", "dirty.txt");
    repo.run("commit", "-q", "-m", "local");
    assert.deepStrictEqual(yield* check(), ["unpushed-commits"]);
    repo.run("push", "-q");
    yield* store.update(taskId, { archivedAt: NOW });
    assert.strictEqual((yield* Effect.flip(workspace.archiveCheck(taskId))).reason, "archived");

    // The legacy pull request counts while no linked thread has a snapshot.
    const prTaskId = WorkTaskId.make("task-2");
    const prCheck = () => workspace.archiveCheck(prTaskId).pipe(Effect.map((r) => r.blockers));
    yield* store.insert(
      workTask(repo.clone, {
        id: prTaskId,
        legacyPullRequest: {
          provider: "github" as never,
          number: 7 as never,
          url: "https://github.com/acme/app/pull/7",
          title: "Widgets",
          state: "draft",
          headBranch: "feature/widgets",
          baseBranch: "main",
          checks: "none",
          review: "none",
          linkedAt: NOW,
          observedAt: NOW,
        },
      }),
    );
    assert.deepStrictEqual(yield* prCheck(), ["pull-request-open"]);

    // A linked thread's snapshot wins over the legacy row, and its live run blocks.
    yield* store.link(ThreadId.make("thread-a"), prTaskId, "user");
    shells.set(
      "thread-a",
      shell("thread-a", {
        status: "running",
        pullRequests: [
          {
            host: "github.com",
            repository: "acme/app",
            number: 7 as never,
            url: "https://github.com/acme/app/pull/7",
            source: "agent",
            linkedAt: NOW,
            stack: null,
            snapshot: {
              state: "merged",
              title: "Widgets",
              headBranch: "feature/widgets",
              baseBranch: "main",
              isDraft: false,
              updatedAt: null,
              syncedAt: NOW,
            },
          },
        ],
      }),
    );
    assert.deepStrictEqual(yield* prCheck(), ["agent-running"]);
    NodeFS.rmSync(repo.root, { recursive: true, force: true });
  }).pipe(Effect.provide(layer)),
);
