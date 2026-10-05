import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ProjectId,
  TaskId,
  type ProjectScript,
  type TaskOperationError,
} from "@t3tools/contracts";
import { assert, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as TaskWorkspaceService from "./TaskWorkspaceService.ts";

const PROJECT_ID = ProjectId.make("project-task-workspace");
const BRANCH = "feature/widgets";

interface Released {
  /** When set, stopSession waits on it: holds an archive mid-way. */
  stopSessionGate?: Effect.Effect<void>;
  readonly sessions: Array<string>;
  readonly terminals: Array<{ readonly threadId: string; readonly deleteHistory?: boolean }>;
}

const makeLayer = (databasePath: string, released: Released) =>
  TaskWorkspaceService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        OrchestrationEngineLive.pipe(
          Layer.provide(OrchestrationProjectionSnapshotQueryLive),
          Layer.provide(OrchestrationProjectionPipelineLive),
        ),
        OrchestrationProjectionSnapshotQueryLive,
      ),
    ),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(makeSqlitePersistenceLive(databasePath)),
    Layer.provide(T3ProjectFileLoader.layer),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mock(ProviderService)({
        stopSession: (input) =>
          Effect.sync(() => void released.sessions.push(input.threadId)).pipe(
            Effect.andThen(Effect.suspend(() => released.stopSessionGate ?? Effect.void)),
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(TerminalManager)({
        close: (input) =>
          Effect.sync(() =>
            released.terminals.push({
              threadId: input.threadId,
              ...(input.deleteHistory === undefined ? {} : { deleteHistory: input.deleteHistory }),
            }),
          ),
      }),
    ),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-task-workspace-" })),
    Layer.provideMerge(NodeServices.layer),
  );

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "TaskWorkspaceService.test",
      cwd,
      args: ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
    });
    return result.stdout.trim();
  });

const writeFile = (filePath: string, contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fs.writeFileString(filePath, contents);
  });

/**
 * A bare "remote" with `main` and `feature/widgets`, and a fresh clone of it
 * as the project root (local branches: `main` only).
 */
const makeRepos = (directory: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const remote = path.join(directory, "remote.git");
    const seed = path.join(directory, "seed");
    const root = path.join(directory, "project");
    yield* git(directory, ["init", "--bare", "-b", "main", remote]);
    yield* git(directory, ["init", "-b", "main", seed]);
    yield* writeFile(path.join(seed, "README.md"), "hello\n");
    yield* git(seed, ["add", "."]);
    yield* git(seed, ["commit", "-m", "init"]);
    yield* git(seed, ["remote", "add", "origin", remote]);
    yield* git(seed, ["push", "origin", "main"]);
    yield* git(seed, ["checkout", "-b", BRANCH]);
    yield* writeFile(path.join(seed, "widgets.txt"), "widgets\n");
    yield* git(seed, ["add", "."]);
    yield* git(seed, ["commit", "-m", "widgets"]);
    yield* git(seed, ["push", "origin", BRANCH]);
    yield* git(directory, ["clone", remote, root]);
    return { root, remote };
  });

const setupProject = (root: string, scripts: ReadonlyArray<ProjectScript> = []) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("cmd-project"),
      projectId: PROJECT_ID,
      title: "Project",
      workspaceRoot: root,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    if (scripts.length > 0) yield* setScripts(scripts);
  });

const setScripts = (scripts: ReadonlyArray<ProjectScript>) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "project.meta.update",
      commandId: CommandId.make(`cmd-scripts-${scripts.map((script) => script.command).join()}`),
      projectId: PROJECT_ID,
      scripts,
    });
  });

const script = (name: string, command: string): ProjectScript => ({
  id: name,
  name,
  command,
  icon: "configure",
  runOnWorktreeCreate: true,
});

const readTask = (taskId: TaskId) =>
  Effect.gen(function* () {
    const snapshots = yield* ProjectionSnapshotQuery;
    return Option.getOrThrow(yield* snapshots.getTaskById(taskId));
  });

const stepsById = (task: {
  readonly workspace: {
    readonly setup: { readonly steps: ReadonlyArray<{ readonly id: string }> };
  };
}) => Object.fromEntries(task.workspace.setup.steps.map((step) => [step.id, step]));

const withRepos = <A, E, R>(
  body: (input: {
    readonly root: string;
    readonly released: Released;
    /** The clone that pushed the remote; commit and push here to move it. */
    readonly seed: string;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-task-workspace-" });
      const released: Released = { sessions: [], terminals: [] };
      return yield* Effect.gen(function* () {
        const { root } = yield* makeRepos(directory);
        return yield* body({ root, released, seed: path.join(directory, "seed") });
      }).pipe(Effect.provide(makeLayer(path.join(directory, "state.sqlite"), released)));
    }),
  );

it.layer(NodeServices.layer)("TaskWorkspaceService", (it) => {
  it.effect(
    "detaches another worktree holding the branch only when asked",
    () =>
      withRepos(({ root }) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const fs = yield* FileSystem.FileSystem;
          const service = yield* TaskWorkspaceService.TaskWorkspaceService;
          yield* setupProject(root);
          const other = path.join(path.dirname(root), "other-worktree");
          yield* git(root, ["worktree", "add", "-b", BRANCH, other, `origin/${BRANCH}`]);
          yield* writeFile(path.join(other, "wip.txt"), "uncommitted\n");
          const head = yield* git(other, ["rev-parse", "HEAD"]);

          const error = yield* service
            .create({ projectId: PROJECT_ID, title: "Widgets", branch: BRANCH })
            .pipe(Effect.flip);
          expect(error).toMatchObject({ reason: "branch-checked-out" });
          const checkoutPath = error.checkoutPath;
          assert(checkoutPath !== undefined);
          expect((yield* (yield* ProjectionSnapshotQuery).getShellSnapshot()).tasks).toEqual([]);

          const { taskId } = yield* service.create({
            projectId: PROJECT_ID,
            title: "Widgets",
            branch: BRANCH,
            detachCheckoutAt: checkoutPath,
          });
          yield* service.awaitSetup(taskId);

          const workspacePath = (yield* readTask(taskId)).workspace.path;
          assert(workspacePath !== null);
          expect(yield* git(workspacePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(BRANCH);
          expect(yield* git(other, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD");
          expect(yield* git(other, ["rev-parse", "HEAD"])).toBe(head);
          expect(yield* fs.readFileString(path.join(other, "wip.txt"))).toBe("uncommitted\n");
        }),
      ),
    { timeout: 60_000 },
  );

  it.effect(
    "takes over a worktree that already holds the branch",
    () =>
      withRepos(({ root }) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const fs = yield* FileSystem.FileSystem;
          const service = yield* TaskWorkspaceService.TaskWorkspaceService;
          yield* setupProject(root);
          const other = path.join(path.dirname(root), "agent-worktree");
          yield* git(root, ["worktree", "add", "-b", BRANCH, other, `origin/${BRANCH}`]);
          yield* writeFile(path.join(other, "wip.txt"), "uncommitted\n");

          const { taskId } = yield* service.create({
            projectId: PROJECT_ID,
            title: "Widgets",
            branch: BRANCH,
            worktreePath: other,
          });
          yield* service.awaitSetup(taskId);

          expect((yield* readTask(taskId)).workspace.path).toBe(yield* fs.realPath(other));
          expect(yield* git(other, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(BRANCH);
          expect(yield* fs.readFileString(path.join(other, "wip.txt"))).toBe("uncommitted\n");

          // A second task can neither adopt nor detach a worktree a live task owns.
          for (const claim of [{ worktreePath: other }, { detachCheckoutAt: other }]) {
            const taken = yield* service
              .create({ projectId: PROJECT_ID, title: "Again", branch: BRANCH, ...claim })
              .pipe(Effect.flip);
            expect(taken).toMatchObject({ reason: "failed" });
          }
          expect(yield* git(other, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(BRANCH);

          const error = yield* service
            .create({ projectId: PROJECT_ID, title: "Main", branch: "main", worktreePath: root })
            .pipe(Effect.flip);
          expect(error).toMatchObject({ reason: "failed" });
        }),
      ),
    { timeout: 60_000 },
  );

  it.effect(
    "never detaches the project's main checkout",
    () =>
      withRepos(({ root }) =>
        Effect.gen(function* () {
          const service = yield* TaskWorkspaceService.TaskWorkspaceService;
          yield* setupProject(root);
          yield* git(root, ["checkout", BRANCH]);

          const error = yield* service
            .create({
              projectId: PROJECT_ID,
              title: "Widgets",
              branch: BRANCH,
              detachCheckoutAt: root,
            })
            .pipe(Effect.flip);
          expect(error).toMatchObject({ reason: "failed" });
          expect(yield* git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(BRANCH);
        }),
      ),
    { timeout: 60_000 },
  );

  it.effect(
    "checks out the existing remote branch, copies files and runs setup scripts",
    () =>
      withRepos(({ root }) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const fs = yield* FileSystem.FileSystem;
          const service = yield* TaskWorkspaceService.TaskWorkspaceService;
          yield* writeFile(path.join(root, ".env.local"), "SECRET=1\n");
          yield* writeFile(path.join(root, "config", "nested", "app.json"), "{}\n");
          yield* writeFile(
            path.join(root, "t3.json"),
            `{"workspace":{"copy":[{"from":".env.local"},{"from":"config","to":"settings"},{"from":"optional-missing.txt"},{"from":"README.md"}]}}`,
          );
          yield* setupProject(root, [script("install", "echo setup-ran")]);
          const branchesBefore = (yield* git(root, ["branch", "--format=%(refname:short)"])).split(
            "\n",
          );

          const { taskId, threadId } = yield* service.create({
            projectId: PROJECT_ID,
            title: "Widgets",
            branch: BRANCH,
          });
          yield* service.awaitSetup(taskId);

          const task = yield* readTask(taskId);
          const workspacePath = task.workspace.path;
          assert(workspacePath !== null);
          expect(task.workspace.setup.status).toBe("ready");
          expect(task.workspace.setup.steps.map((step) => [step.id, step.status])).toEqual([
            ["fetch", "done"],
            ["worktree", "done"],
            ["copy:.env.local", "done"],
            ["copy:config", "done"],
            ["copy:optional-missing.txt", "skipped"],
            ["copy:README.md", "skipped"],
            ["script:install", "done"],
          ]);
          expect(stepsById(task)["script:install"]).toMatchObject({
            log: expect.stringContaining("setup-ran"),
          });

          expect(yield* git(workspacePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(BRANCH);
          expect(yield* git(workspacePath, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
            `origin/${BRANCH}`,
          );
          const branchesAfter = (yield* git(root, ["branch", "--format=%(refname:short)"])).split(
            "\n",
          );
          expect(branchesAfter.toSorted()).toEqual([...branchesBefore, BRANCH].toSorted());

          expect(yield* fs.readFileString(path.join(workspacePath, ".env.local"))).toBe(
            "SECRET=1\n",
          );
          expect(yield* fs.exists(path.join(workspacePath, "settings", "nested", "app.json"))).toBe(
            true,
          );
          // overwrite defaults to false: the checked-out README stays.
          expect(yield* fs.readFileString(path.join(workspacePath, "README.md"))).toBe("hello\n");

          // Two threads share the task workspace.
          const second = yield* service.createThread({ taskId, title: "Second" });
          const snapshots = yield* ProjectionSnapshotQuery;
          const threads = (yield* snapshots.getShellSnapshot()).threads.filter(
            (thread) => thread.taskId === taskId,
          );
          expect(threads.map((thread) => thread.id).toSorted()).toEqual(
            [threadId, second.threadId].toSorted(),
          );
          for (const thread of threads) {
            expect(thread.worktreePath).toBe(workspacePath);
            expect(thread.branch).toBe(BRANCH);
          }

          // Deleting a thread never touches the task workspace.
          const engine = yield* OrchestrationEngineService;
          yield* engine.dispatch({
            type: "thread.delete",
            commandId: CommandId.make("cmd-delete-thread"),
            threadId: second.threadId,
          });
          expect(yield* fs.exists(path.join(workspacePath, "widgets.txt"))).toBe(true);
        }),
      ),
    { timeout: 60_000 },
  );

  it.effect(
    "checks out a branch that exists only locally without an upstream",
    () =>
      withRepos(({ root }) =>
        Effect.gen(function* () {
          const service = yield* TaskWorkspaceService.TaskWorkspaceService;
          yield* setupProject(root);
          yield* git(root, ["branch", "feature/local-only"]);

          const { taskId } = yield* service.create({
            projectId: PROJECT_ID,
            title: "Local",
            branch: "feature/local-only",
          });
          yield* service.awaitSetup(taskId);

          const task = yield* readTask(taskId);
          const workspacePath = task.workspace.path;
          assert(workspacePath !== null);
          expect(task.workspace.setup.status).toBe("ready");
          expect(yield* git(workspacePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(
            "feature/local-only",
          );
          // No upstream until the branch is pushed.
          yield* git(workspacePath, ["rev-parse", "@{upstream}"]).pipe(Effect.flip);
        }),
      ),
    { timeout: 60_000 },
  );

  it.effect(
    "fails with a typed error and no worktree when the remote branch is missing",
    () =>
      withRepos(({ root }) =>
        Effect.gen(function* () {
          const service = yield* TaskWorkspaceService.TaskWorkspaceService;
          const config = yield* ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* setupProject(root);

          const error = yield* service
            .create({ projectId: PROJECT_ID, title: "Ghost", branch: "feature/ghost" })
            .pipe(Effect.flip);

          expect(error).toMatchObject({
            _tag: "TaskOperationError",
            reason: "remote-branch-missing",
          });
          expect(yield* fs.exists(path.join(config.worktreesDir, "project", "feature-ghost"))).toBe(
            false,
          );
          expect(yield* git(root, ["branch", "--format=%(refname:short)"])).toBe("main");
          expect((yield* (yield* ProjectionSnapshotQuery).getShellSnapshot()).tasks).toEqual([]);
        }),
      ),
    { timeout: 60_000 },
  );

  it.effect(
    "fails setup on a missing required file or a failing script and retries to ready",
    () =>
      withRepos(({ root }) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const service = yield* TaskWorkspaceService.TaskWorkspaceService;
          yield* writeFile(
            path.join(root, "t3.json"),
            `{"workspace":{"copy":[{"from":".env.required","required":true}]}}`,
          );
          yield* setupProject(root, [script("install", "echo broken-install && exit 3")]);

          const { taskId } = yield* service.create({
            projectId: PROJECT_ID,
            title: "Widgets",
            branch: BRANCH,
          });
          yield* service.awaitSetup(taskId);
          let task = yield* readTask(taskId);
          expect(task.workspace.setup.status).toBe("failed");
          expect(task.workspace.setup.error).toContain(".env.required");
          expect(stepsById(task)["copy:.env.required"]).toMatchObject({ status: "failed" });
          expect(stepsById(task)["script:install"]).toMatchObject({ status: "pending" });

          // Only failed setups can be retried.
          yield* writeFile(path.join(root, ".env.required"), "A=1\n");
          yield* service.retrySetup(taskId);
          yield* service.awaitSetup(taskId);
          task = yield* readTask(taskId);
          expect(task.workspace.setup.status).toBe("failed");
          expect(stepsById(task)["copy:.env.required"]).toMatchObject({ status: "done" });
          expect(stepsById(task)["script:install"]).toMatchObject({
            status: "failed",
            log: expect.stringContaining("broken-install"),
          });
          expect(task.workspace.setup.error).toContain("exited with code 3");

          yield* setScripts([script("install", "echo fixed-install")]);
          yield* service.retrySetup(taskId);
          yield* service.awaitSetup(taskId);
          task = yield* readTask(taskId);
          expect(task.workspace.setup.status).toBe("ready");
          expect(stepsById(task)["script:install"]).toMatchObject({
            status: "done",
            log: expect.stringContaining("fixed-install"),
          });

          const again = yield* service.retrySetup(taskId).pipe(Effect.flip);
          expect(again.reason).toBe("failed");
        }),
      ),
    { timeout: 60_000 },
  );

  it.effect(
    "blocks archive on uncommitted changes and force-archives while keeping history and branch",
    () =>
      withRepos(({ root, released }) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const fs = yield* FileSystem.FileSystem;
          const service = yield* TaskWorkspaceService.TaskWorkspaceService;
          yield* setupProject(root);
          const { taskId, threadId } = yield* service.create({
            projectId: PROJECT_ID,
            title: "Widgets",
            branch: BRANCH,
          });
          yield* service.awaitSetup(taskId);
          const workspacePath = (yield* readTask(taskId)).workspace.path;
          assert(workspacePath !== null);

          expect(yield* service.archiveCheck(taskId)).toEqual({ blockers: [] });
          yield* writeFile(path.join(workspacePath, "widgets.txt"), "changed\n");
          expect(yield* service.archiveCheck(taskId)).toEqual({
            blockers: ["uncommitted-changes"],
          });

          const blocked = yield* service.archive({ taskId }).pipe(Effect.flip);
          expect(blocked).toMatchObject({
            reason: "archive-blocked",
            blockers: ["uncommitted-changes"],
          });
          expect(yield* fs.exists(workspacePath)).toBe(true);

          yield* service.archive({ taskId, force: true });
          expect(yield* fs.exists(workspacePath)).toBe(false);
          expect(released.sessions).toEqual([threadId]);
          expect(released.terminals).toEqual([{ threadId, deleteHistory: false }]);

          const task = yield* readTask(taskId);
          expect(task.archivedAt).not.toBeNull();
          const snapshots = yield* ProjectionSnapshotQuery;
          const archivedThread = (yield* snapshots.getArchivedShellSnapshot()).threads.find(
            (thread) => thread.id === threadId,
          );
          expect(archivedThread?.taskId).toBe(taskId);
          expect(yield* git(root, ["branch", "--format=%(refname:short)"])).toContain(BRANCH);
          expect(yield* git(root, ["worktree", "list", "--porcelain"])).not.toContain(BRANCH);

          // Archiving again is a no-op.
          yield* service.archive({ taskId });
        }),
      ),
    { timeout: 60_000 },
  );

  it.effect(
    "reports unpushed commits",
    () =>
      withRepos(({ root }) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const service = yield* TaskWorkspaceService.TaskWorkspaceService;
          yield* setupProject(root);
          const { taskId } = yield* service.create({
            projectId: PROJECT_ID,
            title: "Widgets",
            branch: BRANCH,
          });
          yield* service.awaitSetup(taskId);
          const workspacePath = (yield* readTask(taskId)).workspace.path;
          assert(workspacePath !== null);
          yield* writeFile(path.join(workspacePath, "more.txt"), "more\n");
          yield* git(workspacePath, ["add", "."]);
          yield* git(workspacePath, ["commit", "-m", "more"]);

          expect(yield* service.archiveCheck(taskId)).toEqual({ blockers: ["unpushed-commits"] });
        }),
      ),
    { timeout: 60_000 },
  );
  it.effect(
    "marks a setup cut off by a restart as failed so it can be retried",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-task-workspace-" });
          const databasePath = path.join(directory, "state.sqlite");
          const released: Released = { sessions: [], terminals: [] };
          const taskId = TaskId.make("task-interrupted");
          const at = "2026-01-01T00:00:00.000Z";

          // Before the restart: setup was running its install script.
          yield* Effect.gen(function* () {
            yield* setupProject(directory);
            const engine = yield* OrchestrationEngineService;
            yield* engine.dispatch({
              type: "task.create",
              commandId: CommandId.make("cmd-task-interrupted"),
              taskId,
              projectId: PROJECT_ID,
              title: "Widgets",
              description: null,
              workspace: {
                path: path.join(directory, "worktree"),
                branch: BRANCH,
                remoteName: "origin",
                remoteBranch: BRANCH,
                baseBranch: "main",
                setup: {
                  status: "running",
                  steps: [
                    { id: "worktree", label: "Create worktree", status: "done", log: null },
                    {
                      id: "script:install",
                      label: "Run install",
                      status: "running",
                      log: "installing",
                      startedAt: at,
                    },
                    { id: "script:seed", label: "Run seed", status: "pending", log: null },
                  ],
                  error: null,
                  updatedAt: at,
                },
              },
              autoHandleReviewFeedback: false,
              autoHandleCIFailures: false,
              createdAt: at,
            });
          }).pipe(Effect.provide(makeLayer(databasePath, released)));

          // A fresh service on the same state reconciles on start.
          const task = yield* readTask(taskId).pipe(
            Effect.provide(makeLayer(databasePath, released)),
          );
          expect(task.workspace.setup.status).toBe("failed");
          expect(task.workspace.setup.error).toBe(TaskWorkspaceService.SETUP_INTERRUPTED_ERROR);
          expect(task.workspace.setup.steps.map((step) => [step.id, step.status])).toEqual([
            ["worktree", "done"],
            ["script:install", "failed"],
            ["script:seed", "pending"],
          ]);
          expect(stepsById(task)["script:install"]).toMatchObject({
            log: `installing\n${TaskWorkspaceService.SETUP_INTERRUPTED_ERROR}`,
          });
        }),
      ),
    { timeout: 60_000 },
  );

  it.effect(
    "runs only one of two concurrent retries",
    () =>
      withRepos(({ root }) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const service = yield* TaskWorkspaceService.TaskWorkspaceService;
          yield* writeFile(
            path.join(root, "t3.json"),
            `{"workspace":{"copy":[{"from":".env.required","required":true}]}}`,
          );
          yield* setupProject(root);
          const { taskId } = yield* service.create({
            projectId: PROJECT_ID,
            title: "Widgets",
            branch: BRANCH,
          });
          yield* service.awaitSetup(taskId);
          expect((yield* readTask(taskId)).workspace.setup.status).toBe("failed");

          yield* writeFile(path.join(root, ".env.required"), "A=1\n");
          const results = yield* Effect.all(
            [Effect.exit(service.retrySetup(taskId)), Effect.exit(service.retrySetup(taskId))],
            { concurrency: 2 },
          );
          expect(results.filter(Exit.isSuccess)).toHaveLength(1);
          expect(results.filter(Exit.isFailure)).toHaveLength(1);
          yield* service.awaitSetup(taskId);
          expect((yield* readTask(taskId)).workspace.setup.status).toBe("ready");
        }),
      ),
    { timeout: 60_000 },
  );

  it.effect(
    "refuses a new thread or a retry while the task is being archived",
    () =>
      withRepos(({ root, released }) =>
        Effect.gen(function* () {
          const service = yield* TaskWorkspaceService.TaskWorkspaceService;
          yield* setupProject(root);
          const { taskId } = yield* service.create({
            projectId: PROJECT_ID,
            title: "Widgets",
            branch: BRANCH,
          });
          yield* service.awaitSetup(taskId);

          // Hold the archive while it stops the first thread's session.
          const stopping = yield* Deferred.make<void>();
          const resume = yield* Deferred.make<void>();
          released.stopSessionGate = Deferred.succeed(stopping, undefined).pipe(
            Effect.andThen(Deferred.await(resume)),
          );
          const archiving = yield* service.archive({ taskId, force: true }).pipe(Effect.forkScoped);
          yield* Deferred.await(stopping);

          const thread = yield* service.createThread({ taskId, title: "Late" }).pipe(Effect.flip);
          expect(thread).toMatchObject<Partial<TaskOperationError>>({ reason: "archived" });
          const retry = yield* service.retrySetup(taskId).pipe(Effect.flip);
          expect(retry.reason).toBe("archived");

          yield* Deferred.succeed(resume, undefined);
          yield* Fiber.join(archiving);
          const snapshots = yield* ProjectionSnapshotQuery;
          const live = (yield* snapshots.getShellSnapshot()).threads.filter(
            (entry) => entry.taskId === taskId,
          );
          expect(live).toEqual([]);
          expect((yield* readTask(taskId)).archivedAt).not.toBeNull();
        }),
      ),
    { timeout: 60_000 },
  );

  it.effect(
    "rejects branch names git would misread, before running any git command on them",
    () =>
      withRepos(({ root }) =>
        Effect.gen(function* () {
          const service = yield* TaskWorkspaceService.TaskWorkspaceService;
          yield* setupProject(root);
          for (const branch of ["--upload-pack=touch pwned", "-x", "feature..widgets"]) {
            const error = yield* service
              .create({ projectId: PROJECT_ID, title: "Bad", branch })
              .pipe(Effect.flip);
            expect(error).toMatchObject({ _tag: "TaskOperationError", reason: "invalid-branch" });
          }
          expect((yield* (yield* ProjectionSnapshotQuery).getShellSnapshot()).tasks).toEqual([]);
        }),
      ),
    { timeout: 60_000 },
  );

  it.effect(
    "fast-forwards a stale local branch to the remote instead of checking it out behind",
    () =>
      withRepos(({ root, seed }) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const service = yield* TaskWorkspaceService.TaskWorkspaceService;
          yield* setupProject(root);
          // The project already has the branch locally, then the remote moves on.
          yield* git(root, ["branch", "--track", BRANCH, `origin/${BRANCH}`]);
          yield* writeFile(path.join(seed, "newer.txt"), "newer\n");
          yield* git(seed, ["add", "."]);
          yield* git(seed, ["commit", "-m", "newer"]);
          yield* git(seed, ["push", "origin", BRANCH]);
          const remoteHead = yield* git(seed, ["rev-parse", "HEAD"]);
          const branchesBefore = yield* git(root, ["branch", "--format=%(refname:short)"]);

          const { taskId } = yield* service.create({
            projectId: PROJECT_ID,
            title: "Widgets",
            branch: BRANCH,
          });
          yield* service.awaitSetup(taskId);
          const task = yield* readTask(taskId);
          const workspacePath = task.workspace.path;
          assert(workspacePath !== null);

          expect(yield* git(workspacePath, ["rev-parse", "HEAD"])).toBe(remoteHead);
          expect(stepsById(task)["worktree"]).toMatchObject({
            log: expect.stringContaining(`Fast-forwarded local branch ${BRANCH}`),
          });
          expect(yield* git(root, ["branch", "--format=%(refname:short)"])).toBe(branchesBefore);
        }),
      ),
    { timeout: 60_000 },
  );
});
