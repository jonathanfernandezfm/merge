// @effect-diagnostics nodeBuiltinImport:off - fixture repo setup runs outside Effect.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkTaskId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type Project,
  type WorkTask,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../../config.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
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
const launches: Array<ThreadLaunch.ThreadLaunchInput> = [];
const receipts = new Map<string, ThreadId>();
const commands: Array<OrchestrationV2ServerCommand> = [];
const PROJECT_ID = ProjectId.make("project-1");
let projectRoot = "/nowhere";
let worktreesDirectory = "/nowhere";

const project = (): Project => ({
  id: PROJECT_ID,
  title: "App",
  workspaceRoot: projectRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
});

const layerGitWorkflow = Layer.effect(
  GitWorkflow.GitWorkflowService,
  Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    const workflow: Partial<GitWorkflow.GitWorkflowService["Service"]> = {
      createWorktree: (input, options) =>
        git.createWorktree(input, { ...options, worktreesDirectory }),
    };
    return workflow as GitWorkflow.GitWorkflowService["Service"];
  }),
);

const layer = WorkTaskWorkspace.layer.pipe(
  Layer.provideMerge(WorkTaskStore.layer),
  Layer.provideMerge(
    Layer.effectDiscard(runMigrations()).pipe(
      Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
    ),
  ),
  Layer.provide(layerGitWorkflow),
  Layer.provide(
    Layer.mock(ProjectService.ProjectService)({
      getById: (id) => Effect.succeed(id === PROJECT_ID ? Option.some(project()) : Option.none()),
    }),
  ),
  Layer.provide(
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (input) =>
        Effect.sync(() => {
          launches.push(input);
          // Like ThreadLaunchService, a known commandId replays its receipt's thread.
          const replayed = receipts.get(input.commandId);
          if (replayed)
            return { threadId: replayed, projection: undefined as never, resumed: true };
          const threadId = ThreadId.make(`thread-${launches.length}`);
          receipts.set(input.commandId, threadId);
          shells.set(threadId, shell(threadId));
          return { threadId, projection: undefined as never, resumed: false };
        }),
    }),
  ),
  Layer.provide(
    Layer.mock(Orchestrator.OrchestratorV2)({
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
          // A stopped thread's run ends.
          if (command.type === "thread.stop") {
            const stopped = shells.get(command.threadId);
            if (stopped) shells.set(command.threadId, { ...stopped, status: "idle" });
          }
          if (command.type === "thread.archive" && command.threadId === "thread-2") {
            throw new Error("archive refused");
          }
          return { sequence: commands.length, storedEvents: [] };
        }),
    }),
  ),
  Layer.provide(Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void })),
  Layer.provide(ServerSettings.ServerSettingsService.layerTest({})),
  Layer.provide(
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
      listActiveSubagentThreadIds: () =>
        Effect.succeed(
          [...shells.values()]
            .filter((shell) => shell.lineage.relationshipToParent === "subagent")
            .map((shell) => shell.id),
        ),
    }),
  ),
  Layer.provideMerge(
    GitVcsDriver.layer.pipe(
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-work-tasks-test-" })),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

/**
 * A bare remote with `main` and the remote-only `feature/widgets`, and a clone on `main`
 * that is the project root. Worktrees go to `<root>/worktrees`.
 */
const projectRepo = () => {
  const { root, clone, run } = pushedClone();
  run("checkout", "-q", "-b", "main");
  run("push", "-q", "-u", "origin", "main");
  run("branch", "-q", "-D", "feature/widgets");
  projectRoot = clone;
  worktreesDirectory = NodePath.join(root, "worktrees");
  const git = (cwd: string, ...args: string[]) =>
    NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  return { root, clone, run, git };
};

const reset = () => {
  shells.clear();
  receipts.clear();
  launches.length = 0;
  commands.length = 0;
};

const createInput = (overrides: Record<string, unknown> = {}) => ({
  projectId: PROJECT_ID,
  title: "Widgets",
  branch: "feature/widgets",
  ...overrides,
});

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

    // An async subagent child still running after its parent's run ended also blocks.
    shells.set("thread-a", shell("thread-a", { latestRunId: "run-1" as never }));
    assert.deepStrictEqual(yield* prCheck(), ["pull-request-open"]);
    shells.set(
      "child",
      shell("child", {
        status: "running",
        lineage: {
          rootThreadId: ThreadId.make("thread-a"),
          parentThreadId: ThreadId.make("thread-a"),
          relationshipToParent: "subagent",
        },
      }),
    );
    assert.deepStrictEqual(yield* prCheck(), ["pull-request-open", "agent-running"]);
    NodeFS.rmSync(repo.root, { recursive: true, force: true });
  }).pipe(Effect.provide(layer)),
);

it.effect("create on a remote-only branch tracks origin/<b> and creates no new branch", () =>
  Effect.gen(function* () {
    reset();
    const store = yield* WorkTaskStore.WorkTaskStore;
    const workspace = yield* WorkTaskWorkspace.WorkTaskWorkspace;
    const repo = projectRepo();

    const missing = yield* Effect.flip(workspace.create(createInput({ branch: "nope" })));
    assert.strictEqual(missing.reason, "remote-branch-missing");
    assert.strictEqual(
      (yield* Effect.flip(workspace.create(createInput({ branch: "-x" })))).reason,
      "invalid-branch",
    );
    assert.strictEqual(
      (yield* Effect.flip(workspace.create(createInput({ remoteName: "nope" })))).reason,
      "invalid-branch",
    );

    const { taskId, threadId } = yield* workspace.create(createInput());
    const task = (yield* store.get(taskId))!;
    const path = task.workspace.path!;
    assert.strictEqual(task.workspace.setup.status, "ready");
    assert.strictEqual(task.workspace.baseBranch, "main");
    assert.strictEqual(repo.git(path, "rev-parse", "--abbrev-ref", "HEAD"), "feature/widgets");
    assert.strictEqual(
      repo.git(path, "rev-parse", "--abbrev-ref", "@{upstream}"),
      "origin/feature/widgets",
    );
    assert.deepStrictEqual(
      repo.git(repo.clone, "branch", "--format=%(refname:short)").split("\n"),
      ["feature/widgets", "main"],
    );
    assert.deepStrictEqual(
      launches.map((launch) => launch.workspaceStrategy),
      [{ type: "existing_worktree", worktreePath: path, branch: "feature/widgets" }],
    );
    assert.deepStrictEqual(yield* store.links(), [{ threadId, taskId, origin: "user" }]);
    assert.isTrue(yield* store.ownsWorktree(path));

    // The branch belongs to this task now.
    assert.strictEqual((yield* Effect.flip(workspace.create(createInput()))).reason, "failed");
    NodeFS.rmSync(repo.root, { recursive: true, force: true });
  }).pipe(Effect.provide(layer)),
);

it.effect("raises branch-checked-out, then detaches that checkout and continues", () =>
  Effect.gen(function* () {
    reset();
    const store = yield* WorkTaskStore.WorkTaskStore;
    const workspace = yield* WorkTaskWorkspace.WorkTaskWorkspace;
    const repo = projectRepo();
    const other = NodePath.join(repo.root, "other");
    repo.run("worktree", "add", "-q", other, "-b", "feature/held", "origin/feature/widgets");

    const held = yield* Effect.flip(workspace.create(createInput({ branch: "feature/held" })));
    assert.strictEqual(held.reason, "branch-checked-out");
    assert.strictEqual(held.checkoutPath, other);
    assert.deepStrictEqual(yield* store.list(), []);

    const { taskId } = yield* workspace.create(
      createInput({ branch: "feature/held", detachCheckoutAt: other }),
    );
    assert.strictEqual(repo.git(other, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");
    const path = (yield* store.get(taskId))!.workspace.path!;
    assert.notStrictEqual(path, other);
    assert.strictEqual(repo.git(path, "rev-parse", "--abbrev-ref", "HEAD"), "feature/held");
    NodeFS.rmSync(repo.root, { recursive: true, force: true });
  }).pipe(Effect.provide(layer)),
);

it.effect("takes over an existing worktree with its uncommitted changes", () =>
  Effect.gen(function* () {
    reset();
    const store = yield* WorkTaskStore.WorkTaskStore;
    const workspace = yield* WorkTaskWorkspace.WorkTaskWorkspace;
    const repo = projectRepo();
    const mine = NodePath.join(repo.root, "mine");
    repo.run("worktree", "add", "-q", mine, "-b", "feature/mine", "origin/feature/widgets");
    NodeFS.writeFileSync(NodePath.join(mine, "wip.txt"), "draft");

    const notMine = yield* Effect.flip(
      workspace.create(createInput({ branch: "feature/mine", worktreePath: repo.clone })),
    );
    assert.strictEqual(notMine.reason, "failed");

    const { taskId } = yield* workspace.create(
      createInput({ branch: "feature/mine", worktreePath: `${mine}/` }),
    );
    assert.strictEqual((yield* store.get(taskId))!.workspace.path, mine);
    assert.strictEqual(NodeFS.readFileSync(NodePath.join(mine, "wip.txt"), "utf8"), "draft");
    assert.deepStrictEqual(launches.at(-1)?.workspaceStrategy, {
      type: "existing_worktree",
      worktreePath: mine,
      branch: "feature/mine",
    });
    NodeFS.rmSync(repo.root, { recursive: true, force: true });
  }).pipe(Effect.provide(layer)),
);

it.effect("a failed setup retries from the failed step and then opens the first thread", () =>
  Effect.gen(function* () {
    reset();
    const store = yield* WorkTaskStore.WorkTaskStore;
    const workspace = yield* WorkTaskWorkspace.WorkTaskWorkspace;
    const repo = projectRepo();
    NodeFS.writeFileSync(
      NodePath.join(repo.clone, "t3.json"),
      JSON.stringify({ workspace: { copy: [{ from: ".env", required: true }] } }),
    );

    assert.strictEqual((yield* Effect.flip(workspace.create(createInput()))).reason, "failed");
    const [failed] = yield* store.list();
    assert.strictEqual(failed?.workspace.setup.status, "failed");
    assert.deepStrictEqual(
      failed?.workspace.setup.steps.map((step) => [step.id, step.status]),
      [
        ["fetch", "done"],
        ["worktree", "done"],
        ["copy:.env", "failed"],
      ],
    );
    assert.deepStrictEqual(launches, []);
    assert.strictEqual(
      (yield* Effect.flip(workspace.createThread({ taskId: failed!.id }))).reason,
      "failed",
    );

    NodeFS.writeFileSync(NodePath.join(repo.clone, ".env"), "SECRET=1");
    yield* workspace.retrySetup(failed!.id);
    const ready = (yield* store.get(failed!.id))!;
    assert.strictEqual(ready.workspace.setup.status, "ready");
    // Finished steps keep their result; only the copy ran again.
    assert.deepStrictEqual(
      ready.workspace.setup.steps.slice(0, 2),
      failed!.workspace.setup.steps.slice(0, 2),
    );
    assert.strictEqual(
      NodeFS.readFileSync(NodePath.join(ready.workspace.path!, ".env"), "utf8"),
      "SECRET=1",
    );
    assert.strictEqual(launches.length, 1);
    assert.strictEqual((yield* store.links()).length, 1);
    assert.strictEqual((yield* Effect.flip(workspace.retrySetup(failed!.id))).reason, "failed");
    NodeFS.rmSync(repo.root, { recursive: true, force: true });
  }).pipe(Effect.provide(layer)),
);

it.effect("createThread launches in the task worktree and links the thread", () =>
  Effect.gen(function* () {
    reset();
    const store = yield* WorkTaskStore.WorkTaskStore;
    const workspace = yield* WorkTaskWorkspace.WorkTaskWorkspace;
    const repo = projectRepo();
    const { taskId } = yield* workspace.create(createInput());
    const path = (yield* store.get(taskId))!.workspace.path!;

    const { threadId } = yield* workspace.createThread({
      taskId,
      title: "Review feedback",
      origin: "review-feedback",
    });
    const launch = launches.at(-1)!;
    assert.strictEqual(launch.title, "Review feedback");
    assert.strictEqual(launch.projectId, PROJECT_ID);
    // Only the first thread runs the project setup script.
    assert.deepStrictEqual(
      launches.map((entry) => entry.workspaceStrategy),
      [
        { type: "existing_worktree", worktreePath: path, branch: "feature/widgets" },
        {
          type: "existing_worktree",
          worktreePath: path,
          branch: "feature/widgets",
          skipSetupScript: true,
        },
      ],
    );
    assert.deepStrictEqual(
      (yield* store.links()).find((link) => link.threadId === threadId),
      { threadId, taskId, origin: "review-feedback" },
    );

    yield* workspace.setWaiting({ taskId, reason: "Pick a base" });
    yield* workspace.setAutoHandle({ taskId, enabled: true });
    const task = (yield* store.get(taskId))!;
    assert.strictEqual(task.waitingForUserReason, "Pick a base");
    assert.isTrue(task.autoHandleReviewFeedback);
    yield* workspace.setWaiting({ taskId, reason: null });
    assert.isNull((yield* store.get(taskId))!.waitingForUserReason);
    NodeFS.rmSync(repo.root, { recursive: true, force: true });
  }).pipe(Effect.provide(layer)),
);

it.effect("createThread with a fixed commandId replays the launch and still writes the link", () =>
  Effect.gen(function* () {
    reset();
    const store = yield* WorkTaskStore.WorkTaskStore;
    const workspace = yield* WorkTaskWorkspace.WorkTaskWorkspace;
    const repo = projectRepo();
    const { taskId } = yield* workspace.create(createInput());
    const commandId = CommandId.make(`merge:work-task-review:${taskId}`);
    const input = {
      taskId,
      title: "Review feedback",
      origin: "review-feedback" as const,
      commandId,
    };

    const first = yield* workspace.createThread(input);
    // A crash between launch and link: the link is lost, the receipt is not.
    yield* store.unlink(first.threadId);
    const second = yield* workspace.createThread(input);

    assert.strictEqual(second.threadId, first.threadId);
    assert.deepStrictEqual(
      launches.slice(-2).map((launch) => launch.commandId),
      [commandId, commandId],
    );
    assert.deepStrictEqual(
      (yield* store.links()).filter((link) => link.origin === "review-feedback"),
      [{ threadId: first.threadId, taskId, origin: "review-feedback" }],
    );
    NodeFS.rmSync(repo.root, { recursive: true, force: true });
  }).pipe(Effect.provide(layer)),
);

it.effect("archive stops and archives the threads and removes the worktree", () =>
  Effect.gen(function* () {
    reset();
    const store = yield* WorkTaskStore.WorkTaskStore;
    const workspace = yield* WorkTaskWorkspace.WorkTaskWorkspace;
    const repo = projectRepo();
    const { taskId, threadId } = yield* workspace.create(createInput());
    // thread-2's archive is refused by the orchestrator mock; archive still completes.
    const second = yield* workspace.createThread({ taskId });
    const path = (yield* store.get(taskId))!.workspace.path!;
    NodeFS.writeFileSync(NodePath.join(path, "dirty.txt"), "x");
    shells.set(threadId, shell(threadId, { status: "running" }));
    shells.set(
      "child",
      shell("child", {
        status: "running",
        lineage: {
          rootThreadId: threadId,
          parentThreadId: threadId,
          relationshipToParent: "subagent",
        },
      }),
    );

    const blocked = yield* Effect.flip(workspace.archive({ taskId }));
    assert.strictEqual(blocked.reason, "archive-blocked");
    assert.deepStrictEqual(blocked.blockers, ["uncommitted-changes", "agent-running"]);
    assert.isTrue(NodeFS.existsSync(path));

    yield* workspace.archive({ taskId, force: true });
    assert.isFalse(NodeFS.existsSync(path));
    // Every holder, the subagent included, is stopped before the worktree goes.
    assert.deepStrictEqual(
      commands.map((command): [string, string | null] => [
        command.type,
        "threadId" in command ? command.threadId : null,
      ]),
      [
        ["thread.stop", threadId],
        ["thread.stop", second.threadId],
        ["thread.stop", "child"],
        ["thread.archive", threadId],
        ["thread.archive", second.threadId],
      ],
    );
    assert.isNotNull((yield* store.get(taskId))!.archivedAt);
    assert.isFalse(yield* store.ownsWorktree(path));
    // The branch stays; only the worktree is gone.
    assert.include(repo.git(repo.clone, "branch", "--format=%(refname:short)"), "feature/widgets");
    assert.strictEqual((yield* Effect.flip(workspace.createThread({ taskId }))).reason, "archived");
    yield* workspace.archive({ taskId });
    NodeFS.rmSync(repo.root, { recursive: true, force: true });
  }).pipe(Effect.provide(layer)),
);

it.effect("archive without force surfaces git's refusal and keeps the task", () =>
  Effect.gen(function* () {
    reset();
    const store = yield* WorkTaskStore.WorkTaskStore;
    const workspace = yield* WorkTaskWorkspace.WorkTaskWorkspace;
    const repo = projectRepo();
    const { taskId } = yield* workspace.create(createInput());
    const path = (yield* store.get(taskId))!.workspace.path!;
    // Clean, so no blocker; but a locked worktree makes `git worktree remove` refuse.
    repo.run("worktree", "lock", path);

    const refused = yield* Effect.flip(workspace.archive({ taskId }));
    assert.strictEqual(refused.reason, "failed");
    assert.include(refused.message, "Git refused to remove the worktree");
    assert.isTrue(NodeFS.existsSync(path));
    assert.isNull((yield* store.get(taskId))!.archivedAt);
    repo.run("worktree", "unlock", path);
    NodeFS.rmSync(repo.root, { recursive: true, force: true });
  }).pipe(Effect.provide(layer)),
);
