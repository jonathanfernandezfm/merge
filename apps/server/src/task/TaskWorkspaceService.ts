/**
 * TaskWorkspaceService - creates, prepares and archives the git worktree a
 * task works in.
 *
 * A task always works on an EXISTING remote branch: the service fetches the
 * remote, checks out the local tracking branch of the same name in a new
 * worktree and never creates any other branch. Setup (copy rules from
 * `t3.json`, then the project's `runOnWorktreeCreate` scripts) runs in the
 * background and reports each step through `task.sync`. Archive removes the
 * worktree but keeps the branch, the task and its threads.
 *
 * @module TaskWorkspaceService
 */
import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProviderInstanceId,
  TaskId,
  ThreadId,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationTask,
  type OrchestrationTaskSetupStep,
  type OrchestrationTaskWorkspace,
  type OrchestrationThreadShell,
  type ProjectScript,
  type T3ProjectFileWorkspaceCopyRule,
  type TaskArchiveBlocker,
  type TaskArchiveCheckResult,
  type TaskArchiveInput,
  type TaskCreateInput,
  type ThreadOrigin,
  type GitCommandError,
  TaskOperationError,
} from "@t3tools/contracts";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as ProviderService from "../provider/Services/ProviderService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { DEFAULT_THREAD_TITLE } from "../orchestration/threadTitles.ts";
import { forkParked, ServerActivation } from "../serverActivation.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";

/** Each step keeps only the tail of its output; installs can print megabytes. */
export const TASK_SETUP_STEP_LOG_MAX_CHARS = 8_000;

export const SETUP_INTERRUPTED_ERROR = "Setup was interrupted (server restarted).";

export interface TaskCreateThreadOptions {
  readonly taskId: TaskId;
  /** A pre-minted id, for callers that must record it before the thread exists. */
  readonly threadId?: ThreadId | undefined;
  readonly title?: string | undefined;
  /** Defaults to `user`. Automated threads (review feedback, CI) pass their own. */
  readonly origin?: ThreadOrigin | undefined;
  /** When set, the thread starts a turn with this user message right away. */
  readonly initialMessage?: string | undefined;
}

export class TaskWorkspaceService extends Context.Service<
  TaskWorkspaceService,
  {
    /**
     * Create a task on an existing remote branch: fetch, create the task,
     * check out the worktree, create the first thread, then fork the rest of
     * setup. Resolves before copy rules and scripts finish.
     */
    readonly create: (
      input: TaskCreateInput,
    ) => Effect.Effect<
      { readonly taskId: TaskId; readonly threadId: ThreadId },
      TaskOperationError
    >;
    /** Rerun a failed setup from its first unfinished step. */
    readonly retrySetup: (taskId: TaskId) => Effect.Effect<void, TaskOperationError>;
    readonly createThread: (
      input: TaskCreateThreadOptions,
    ) => Effect.Effect<{ readonly threadId: ThreadId }, TaskOperationError>;
    readonly archiveCheck: (
      taskId: TaskId,
    ) => Effect.Effect<TaskArchiveCheckResult, TaskOperationError>;
    readonly archive: (input: TaskArchiveInput) => Effect.Effect<void, TaskOperationError>;
    /** Wait for the background setup of a task, if one is running. */
    readonly awaitSetup: (taskId: TaskId) => Effect.Effect<void>;
  }
>()("t3/task/TaskWorkspaceService") {}

const archivingError = () =>
  new TaskOperationError({
    reason: "archived",
    message: "The task is being archived.",
  });

const failed = (message: string, cause?: unknown) =>
  new TaskOperationError({
    reason: "failed",
    message: message.trim() || "Task operation failed.",
    ...(cause === undefined ? {} : { cause }),
  });

const errorDetail = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    if ("detail" in error && typeof error.detail === "string" && error.detail.trim()) {
      return error.detail.trim();
    }
    if ("message" in error && typeof error.message === "string" && error.message.trim()) {
      return error.message.trim();
    }
  }
  return "unknown error";
};

/** Keeps the last `max` characters of a log. */
export const tailLog = (log: string, max = TASK_SETUP_STEP_LOG_MAX_CHARS): string =>
  log.length <= max ? log : `…${log.slice(log.length - max + 1)}`;

export const copyStepId = (rule: T3ProjectFileWorkspaceCopyRule) => `copy:${rule.from}`;
export const scriptStepId = (script: ProjectScript) => `script:${script.name}`;

interface SetupPlan {
  readonly copyRules: ReadonlyArray<T3ProjectFileWorkspaceCopyRule>;
  readonly scripts: ReadonlyArray<ProjectScript>;
}

const pendingStep = (id: string, label: string): OrchestrationTaskSetupStep => ({
  id,
  label,
  status: "pending",
  log: null,
});

/**
 * Steps in run order: `fetch`, `worktree`, one `copy:<from>` per copy rule and
 * one `script:<name>` per `runOnWorktreeCreate` script.
 */
export const planSetupSteps = (
  remoteRef: string,
  plan: SetupPlan,
): Array<OrchestrationTaskSetupStep> => [
  pendingStep("fetch", `Fetch ${remoteRef}`),
  pendingStep("worktree", "Create worktree"),
  ...plan.copyRules.map((rule) =>
    pendingStep(
      copyStepId(rule),
      rule.to && rule.to !== rule.from ? `Copy ${rule.from} to ${rule.to}` : `Copy ${rule.from}`,
    ),
  ),
  ...plan.scripts.map((script) => pendingStep(scriptStepId(script), `Run ${script.name}`)),
];

type StepOutcome =
  | { readonly status: "done" | "skipped"; readonly log: string | null }
  | { readonly status: "failed"; readonly log: string | null; readonly error: string };

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const projectFiles = yield* T3ProjectFileLoader.T3ProjectFileLoader;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const providers = yield* ProviderService.ProviderService;
  const terminals = yield* TerminalManager.TerminalManager;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  const setupScope = yield* Scope.make("parallel");
  yield* Effect.addFinalizer(() => Scope.close(setupScope, Exit.void));
  const setupFibers = new Map<TaskId, Fiber.Fiber<void>>();
  /**
   * Tasks whose archive is in flight. Set synchronously when archive starts so
   * no new thread or setup can slip into a worktree that is being removed.
   */
  const archiving = new Set<TaskId>();
  /** Tasks with a retry between its checks and its fork. */
  const retrying = new Set<TaskId>();

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const commandId = (tag: string) =>
    uuid.pipe(Effect.map((id) => CommandId.make(`server:task-${tag}:${id}`)));
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const dispatch = (
    command: Parameters<OrchestrationEngine.OrchestrationEngineShape["dispatch"]>[0],
  ) =>
    engine
      .dispatch(command)
      .pipe(
        Effect.mapError((error) =>
          failed(`Failed to ${command.type}: ${errorDetail(error)}`, error),
        ),
      );

  const inside = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };

  const exists = (target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => false));

  const requireTask = Effect.fn("TaskWorkspaceService.requireTask")(function* (taskId: TaskId) {
    const task = yield* snapshots
      .getTaskById(taskId)
      .pipe(Effect.mapError((error) => failed("Failed to read the task.", error)));
    if (Option.isNone(task) || task.value.deletedAt !== null) {
      return yield* new TaskOperationError({
        reason: "not-found",
        message: `Task '${taskId}' was not found.`,
      });
    }
    return task.value;
  });

  const requireActiveTask = Effect.fn("TaskWorkspaceService.requireActiveTask")(function* (
    taskId: TaskId,
  ) {
    const task = yield* requireTask(taskId);
    if (task.archivedAt !== null) {
      return yield* new TaskOperationError({
        reason: "archived",
        message: `Task '${task.title}' is archived.`,
      });
    }
    return task;
  });

  const requireProject = Effect.fn("TaskWorkspaceService.requireProject")(function* (
    projectId: OrchestrationTask["projectId"],
  ) {
    const project = yield* snapshots
      .getProjectShellById(projectId)
      .pipe(Effect.mapError((error) => failed("Failed to read the project.", error)));
    if (Option.isNone(project)) {
      return yield* new TaskOperationError({
        reason: "not-found",
        message: `Project '${projectId}' was not found.`,
      });
    }
    return project.value;
  });

  const loadSetupPlan = Effect.fn("TaskWorkspaceService.loadSetupPlan")(function* (
    project: OrchestrationProjectShell,
  ) {
    const projectFile = yield* projectFiles.load(project.workspaceRoot);
    return {
      copyRules: Option.match(projectFile, {
        onNone: () => [],
        onSome: (file) => file.workspace?.copy ?? [],
      }),
      scripts: project.scripts.filter((script) => script.runOnWorktreeCreate),
    } satisfies SetupPlan;
  });

  const listTaskThreads = Effect.fn("TaskWorkspaceService.listTaskThreads")(function* (
    taskId: TaskId,
  ) {
    const snapshot = yield* snapshots
      .getShellSnapshot()
      .pipe(Effect.mapError((error) => failed("Failed to read the task threads.", error)));
    return snapshot.threads.filter((thread) => thread.taskId === taskId);
  });

  // --- Workspace state ---------------------------------------------------

  const syncWorkspace = (taskId: TaskId, workspace: OrchestrationTaskWorkspace) =>
    Effect.gen(function* () {
      yield* dispatch({
        type: "task.sync",
        commandId: yield* commandId("sync"),
        taskId,
        workspace,
      });
    });

  const withStep = (
    workspace: OrchestrationTaskWorkspace,
    stepId: string,
    patch: Partial<OrchestrationTaskSetupStep>,
    updatedAt: string,
  ): OrchestrationTaskWorkspace => ({
    ...workspace,
    setup: {
      ...workspace.setup,
      updatedAt,
      steps: workspace.setup.steps.map((step) =>
        step.id === stepId ? { ...step, ...patch } : step,
      ),
    },
  });

  // --- Git ---------------------------------------------------------------

  const gitOutput = (cwd: string, operation: string, args: ReadonlyArray<string>) =>
    git
      .execute({ operation, cwd, args, allowNonZeroExit: true })
      .pipe(Effect.map((result) => ({ ok: result.exitCode === 0, stdout: result.stdout })));

  /** Which worktree (main checkout included) has `branch` checked out, if any. */
  const findCheckout = Effect.fn("TaskWorkspaceService.findCheckout")(function* (
    root: string,
    branch: string,
  ) {
    const result = yield* gitOutput(root, "TaskWorkspaceService.listWorktrees", [
      "worktree",
      "list",
      "--porcelain",
    ]);
    let current: string | null = null;
    for (const line of result.stdout.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) current = line.slice("worktree ".length);
      if (line === `branch refs/heads/${branch}`) return current ?? root;
    }
    return null;
  });

  /**
   * Bring an existing local branch up to its remote before checking it out.
   * Behind: fast-forward it (it is checked out nowhere, so this is safe). Equal:
   * nothing. Ahead or diverged: keep the local commits and say so. Returns the
   * line for the worktree step log.
   */
  const syncLocalBranch = Effect.fn("TaskWorkspaceService.syncLocalBranch")(function* (
    root: string,
    workspace: OrchestrationTaskWorkspace,
  ) {
    const { branch, remoteName, remoteBranch } = workspace;
    const localRef = `refs/heads/${branch}`;
    const remoteRef = `refs/remotes/${remoteName}/${remoteBranch}`;
    const remoteLabel = `${remoteName}/${remoteBranch}`;
    const local = yield* gitOutput(root, "TaskWorkspaceService.localBranchHead", [
      "rev-parse",
      "--verify",
      "--quiet",
      localRef,
    ]);
    const remote = yield* gitOutput(root, "TaskWorkspaceService.remoteBranchHead", [
      "rev-parse",
      "--verify",
      "--quiet",
      remoteRef,
    ]);
    if (!local.ok || !remote.ok) {
      return `Reusing local branch ${branch}; could not compare it with ${remoteLabel}`;
    }
    if (local.stdout.trim() === remote.stdout.trim()) {
      return `Reusing local branch ${branch}, up to date with ${remoteLabel}`;
    }
    const behind = yield* gitOutput(root, "TaskWorkspaceService.localBranchBehind", [
      "merge-base",
      "--is-ancestor",
      localRef,
      remoteRef,
    ]);
    if (behind.ok) {
      yield* git.execute({
        operation: "TaskWorkspaceService.fastForwardLocalBranch",
        cwd: root,
        args: ["branch", "-f", "--", branch, remoteRef],
      });
      return `Fast-forwarded local branch ${branch} to ${remoteLabel}`;
    }
    const ahead = yield* gitOutput(root, "TaskWorkspaceService.localBranchAhead", [
      "merge-base",
      "--is-ancestor",
      remoteRef,
      localRef,
    ]);
    return ahead.ok
      ? `Note: local branch ${branch} has commits that are not on ${remoteLabel}. Kept the local branch; push them when ready.`
      : `Note: local branch ${branch} has diverged from ${remoteLabel}. Kept the local branch as is; reconcile it with the remote before pushing.`;
  });

  /**
   * Check out the existing branch in a worktree. Reuses local `branch` when it
   * exists, otherwise creates it tracking `remoteName/branch`. Never creates a
   * branch under any other name.
   */
  const ensureWorktree = Effect.fn("TaskWorkspaceService.ensureWorktree")(function* (
    root: string,
    workspace: OrchestrationTaskWorkspace,
  ) {
    const { branch, remoteName, remoteBranch } = workspace;
    if (workspace.path !== null && (yield* exists(workspace.path))) {
      return { path: workspace.path, log: `Reusing ${workspace.path}` };
    }
    // A worktree directory deleted outside the app leaves a registration
    // behind that would block `worktree add` and the checkout check below.
    yield* git.pruneWorktrees({ cwd: root });
    const checkout = yield* findCheckout(root, branch);
    if (checkout !== null) {
      return yield* failed(
        `Branch '${branch}' is already checked out at ${checkout}. Switch that checkout to another branch, then retry.`,
      );
    }
    const localBranches = yield* git.listLocalBranchNames(root);
    const log: Array<string> = [];
    if (localBranches.includes(branch)) {
      log.push(yield* syncLocalBranch(root, workspace));
    } else {
      yield* git.execute({
        operation: "TaskWorkspaceService.trackRemoteBranch",
        cwd: root,
        args: ["branch", "--track", "--", branch, `refs/remotes/${remoteName}/${remoteBranch}`],
      });
      log.push(`Created local branch ${branch} tracking ${remoteName}/${remoteBranch}`);
    }
    const created = yield* git.createWorktree(
      { cwd: root, refName: branch, path: workspace.path },
      { submodules: null },
    );
    yield* git.setBranchUpstream({ cwd: root, branch, remoteName, remoteBranch });
    log.push(`Checked out ${branch} at ${created.worktree.path}`);
    return { path: created.worktree.path, log: log.join("\n") };
  });

  // --- Setup steps -------------------------------------------------------

  const runCopyRule = Effect.fn("TaskWorkspaceService.runCopyRule")(function* (
    root: string,
    worktreePath: string,
    rule: T3ProjectFileWorkspaceCopyRule,
  ) {
    const source = path.resolve(root, rule.from);
    const destination = path.resolve(worktreePath, rule.to ?? rule.from);
    if (!inside(root, source)) {
      return {
        status: "failed",
        log: null,
        error: `Copy source '${rule.from}' is outside the project.`,
      } satisfies StepOutcome;
    }
    if (!inside(worktreePath, destination)) {
      return {
        status: "failed",
        log: null,
        error: `Copy destination '${rule.to ?? rule.from}' is outside the workspace.`,
      } satisfies StepOutcome;
    }
    if (!(yield* exists(source))) {
      return rule.required
        ? ({
            status: "failed",
            log: null,
            error: `Required file '${rule.from}' is missing from the project.`,
          } satisfies StepOutcome)
        : ({ status: "skipped", log: `${rule.from} not found` } satisfies StepOutcome);
    }
    if (yield* exists(destination)) {
      if (!rule.overwrite) {
        yield* Effect.logInfo("task workspace copy kept an existing destination", {
          from: rule.from,
          to: rule.to ?? rule.from,
        });
        return {
          status: "skipped",
          log: `${rule.to ?? rule.from} already exists, kept it`,
        } satisfies StepOutcome;
      }
      yield* fs.remove(destination, { recursive: true });
    }
    yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
    yield* fs.copy(source, destination);
    return {
      status: "done",
      log: `Copied ${rule.from} to ${rule.to ?? rule.from}`,
    } satisfies StepOutcome;
  });

  /** Runs one script through the platform shell, keeping a capped output tail. */
  const runScript = Effect.fn("TaskWorkspaceService.runScript")(function* (
    root: string,
    worktreePath: string,
    script: ProjectScript,
  ) {
    let output = "";
    const append = (text: string) => {
      output = tailLog(output + text);
    };
    const exitCode = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(script.command, [], {
            cwd: worktreePath,
            env: projectScriptRuntimeEnv({ project: { cwd: root }, worktreePath }),
            extendEnv: true,
            shell: true,
          }),
        );
        yield* handle.all.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) => Effect.sync(() => append(chunk))),
        );
        return yield* handle.exitCode;
      }),
    );
    const log = output.length > 0 ? output : null;
    return exitCode === 0
      ? ({ status: "done", log } satisfies StepOutcome)
      : ({
          status: "failed",
          log,
          error: `${script.name} exited with code ${exitCode}.`,
        } satisfies StepOutcome);
  });

  /**
   * Run every unfinished step (or only those in `only`). Each step is synced
   * as running, then with its outcome. The first failure marks setup failed
   * and leaves later steps pending.
   */
  const runSteps = Effect.fn("TaskWorkspaceService.runSteps")(function* (
    taskId: TaskId,
    root: string,
    initial: OrchestrationTaskWorkspace,
    plan: SetupPlan,
    only?: ReadonlySet<string>,
  ) {
    let workspace = initial;
    for (const step of initial.setup.steps) {
      if (step.status === "done" || step.status === "skipped") continue;
      if (only !== undefined && !only.has(step.id)) continue;
      const startedAt = yield* nowIso;
      workspace = withStep(
        workspace,
        step.id,
        { status: "running", log: null, startedAt, finishedAt: null },
        startedAt,
      );
      yield* syncWorkspace(taskId, workspace);

      const outcome = yield* runStep(root, workspace, step.id, plan).pipe(
        Effect.catch((error) =>
          Effect.succeed<StepOutcome & { readonly path?: string }>({
            status: "failed",
            log: null,
            error: errorDetail(error),
          }),
        ),
      );
      const finishedAt = yield* nowIso;
      workspace = withStep(
        outcome.path === undefined ? workspace : { ...workspace, path: outcome.path },
        step.id,
        {
          status: outcome.status,
          log: outcome.log === null ? null : tailLog(outcome.log),
          finishedAt,
        },
        finishedAt,
      );
      if (outcome.status === "failed") {
        workspace = {
          ...workspace,
          setup: { ...workspace.setup, status: "failed", error: outcome.error },
        };
        yield* syncWorkspace(taskId, workspace);
        return workspace;
      }
      yield* syncWorkspace(taskId, workspace);
    }
    return workspace;
  });

  const runSetup = Effect.fn("TaskWorkspaceService.runSetup")(function* (
    taskId: TaskId,
    root: string,
    initial: OrchestrationTaskWorkspace,
    plan: SetupPlan,
  ) {
    const workspace = yield* runSteps(taskId, root, initial, plan);
    if (workspace.setup.status === "failed") return;
    yield* syncWorkspace(taskId, {
      ...workspace,
      setup: { ...workspace.setup, status: "ready", error: null, updatedAt: yield* nowIso },
    });
  });

  const runStep = (
    root: string,
    workspace: OrchestrationTaskWorkspace,
    stepId: string,
    plan: SetupPlan,
  ): Effect.Effect<
    StepOutcome & { readonly path?: string },
    GitCommandError | PlatformError.PlatformError | TaskOperationError
  > => {
    if (stepId === "fetch") {
      return git
        .fetchRemote({
          cwd: root,
          remoteName: workspace.remoteName,
          refName: workspace.remoteBranch,
        })
        .pipe(
          Effect.as({
            status: "done",
            log: `Fetched ${workspace.remoteName}/${workspace.remoteBranch}`,
          } as const),
        );
    }
    if (stepId === "worktree") {
      return ensureWorktree(root, workspace).pipe(
        Effect.map((result) => ({ status: "done", log: result.log, path: result.path }) as const),
      );
    }
    if (workspace.path === null) {
      return Effect.succeed({
        status: "failed",
        log: null,
        error: "The workspace has no worktree.",
      } as const);
    }
    const worktreePath = workspace.path;
    const rule = plan.copyRules.find((entry) => copyStepId(entry) === stepId);
    if (rule) return runCopyRule(root, worktreePath, rule);
    const script = plan.scripts.find((entry) => scriptStepId(entry) === stepId);
    if (script) return runScript(root, worktreePath, script);
    return Effect.succeed({
      status: "skipped",
      log: "This step is no longer configured.",
    } as const);
  };

  const forkSetup = (
    taskId: TaskId,
    root: string,
    workspace: OrchestrationTaskWorkspace,
    plan: SetupPlan,
  ) =>
    Effect.gen(function* () {
      if (archiving.has(taskId)) return;
      const fiber = yield* runSetup(taskId, root, workspace, plan).pipe(
        Effect.asVoid,
        Effect.ignoreCause({ log: true }),
        Effect.ensuring(Effect.sync(() => setupFibers.delete(taskId))),
        Effect.forkIn(setupScope),
      );
      setupFibers.set(taskId, fiber);
    });

  // --- Threads -----------------------------------------------------------

  const createTaskThread = Effect.fn("TaskWorkspaceService.createTaskThread")(function* (
    task: OrchestrationTask,
    project: OrchestrationProjectShell,
    options: Omit<TaskCreateThreadOptions, "taskId">,
  ) {
    if (archiving.has(task.id)) return yield* archivingError();
    const workspacePath = task.workspace.path;
    if (
      workspacePath === null ||
      (task.workspace.setup.status !== "ready" && task.workspace.setup.status !== "running")
    ) {
      return yield* failed("The task workspace is not ready. Retry its setup first.");
    }
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError((error) => failed("Failed to read settings.", error)),
    );
    const projectSettings = resolveProjectSettings(settings, project.id, project).settings;
    const modelSelection: ModelSelection = projectSettings.defaultModelSelection ??
      settings.defaultModelSelection ?? {
        instanceId: ProviderInstanceId.make("codex"),
        model: DEFAULT_MODEL,
      };
    const threadId = options.threadId ?? ThreadId.make(yield* uuid);
    const createdAt = yield* nowIso;
    // Checked again after the settings read: archive may have started meanwhile.
    if (archiving.has(task.id)) return yield* archivingError();
    yield* dispatch({
      type: "thread.create",
      commandId: yield* commandId("thread-create"),
      threadId,
      projectId: project.id,
      // Untitled threads get the shared default so the provider reactor names
      // them from their first message; tabs would otherwise all repeat the task title.
      title: options.title?.trim() || DEFAULT_THREAD_TITLE,
      modelSelection,
      runtimeMode: projectSettings.defaultRuntimeMode,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: task.workspace.branch,
      worktreePath: workspacePath,
      taskId: task.id,
      origin: options.origin ?? "user",
      createdAt,
    });
    if (options.initialMessage !== undefined && options.initialMessage.trim().length > 0) {
      yield* dispatch({
        type: "thread.turn.start",
        commandId: yield* commandId("turn-start"),
        threadId,
        message: {
          messageId: MessageId.make(yield* uuid),
          role: "user",
          text: options.initialMessage,
          attachments: [],
        },
        runtimeMode: projectSettings.defaultRuntimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: yield* nowIso,
      });
    }
    return { threadId };
  });

  /**
   * A name git would read as an option, or that is not a valid branch name, is
   * rejected before it reaches any git command line.
   */
  const requireValidBranchName = Effect.fn("TaskWorkspaceService.requireValidBranchName")(
    function* (root: string, branch: string) {
      const invalid = new TaskOperationError({
        reason: "invalid-branch",
        message: `'${branch}' is not a valid branch name.`,
      });
      if (branch.startsWith("-")) return yield* invalid;
      const check = yield* gitOutput(root, "TaskWorkspaceService.checkBranchName", [
        "check-ref-format",
        "--branch",
        branch,
      ]).pipe(Effect.mapError((error) => failed(errorDetail(error), error)));
      if (!check.ok) return yield* invalid;
    },
  );

  // --- Startup reconcile ---------------------------------------------------

  /**
   * Setup runs in a fiber of this process, so a setup still `running` or
   * `pending` when the service starts was cut off by a restart. Mark it failed
   * so the task can be retried instead of looking busy forever.
   */
  const failInterruptedSetups = Effect.gen(function* () {
    const shell = yield* snapshots.getShellSnapshot();
    const candidates = (shell.tasks ?? []).filter(
      (task) =>
        task.archivedAt === null &&
        task.deletedAt === null &&
        (task.workspace.setup.status === "running" || task.workspace.setup.status === "pending") &&
        !setupFibers.has(task.id),
    );
    for (const candidate of candidates) {
      // The shell omits step logs, so read the full task before rewriting it.
      const task = yield* snapshots.getTaskById(candidate.id);
      if (Option.isNone(task)) continue;
      const { workspace } = task.value;
      const updatedAt = yield* nowIso;
      yield* syncWorkspace(task.value.id, {
        ...workspace,
        setup: {
          ...workspace.setup,
          status: "failed",
          error: SETUP_INTERRUPTED_ERROR,
          updatedAt,
          steps: workspace.setup.steps.map((step) =>
            step.status === "running"
              ? {
                  ...step,
                  status: "failed" as const,
                  finishedAt: updatedAt,
                  log: tailLog(
                    step.log === null
                      ? SETUP_INTERRUPTED_ERROR
                      : `${step.log}\n${SETUP_INTERRUPTED_ERROR}`,
                  ),
                }
              : step,
          ),
        },
      });
      yield* Effect.logInfo("task setup interrupted by a restart was marked failed", {
        taskId: task.value.id,
      });
    }
  }).pipe(Effect.ignoreCause({ log: true }));

  // Like other startup recovery, run inline when nothing gates activation
  // (tests), otherwise once the server activates.
  if ((yield* ServerActivation) === undefined) {
    yield* failInterruptedSetups;
  } else {
    yield* forkParked(failInterruptedSetups);
  }

  // --- Public API ----------------------------------------------------------

  const create: TaskWorkspaceService["Service"]["create"] = Effect.fn(
    "TaskWorkspaceService.create",
  )(function* (input) {
    const project = yield* requireProject(input.projectId);
    const root = project.workspaceRoot;
    const branch = input.branch.trim();
    yield* requireValidBranchName(root, branch);
    const remoteName =
      input.remoteName ??
      (yield* git.resolvePrimaryRemoteName(root).pipe(Effect.orElseSucceed(() => "origin")));
    if (remoteName.startsWith("-")) {
      return yield* new TaskOperationError({
        reason: "invalid-branch",
        message: `'${remoteName}' is not a valid remote name.`,
      });
    }
    const remoteRef = `${remoteName}/${branch}`;

    yield* git
      .fetchRemote({ cwd: root, remoteName, refName: branch })
      .pipe(
        Effect.mapError((error) =>
          failed(`Could not fetch ${remoteName}: ${errorDetail(error)}`, error),
        ),
      );
    const remoteBranchExists = yield* git
      .remoteBranchExists({ cwd: root, remoteName, refName: branch })
      .pipe(Effect.mapError((error) => failed(errorDetail(error), error)));
    if (!remoteBranchExists) {
      return yield* new TaskOperationError({
        reason: "remote-branch-missing",
        message: `Branch '${branch}' does not exist on ${remoteName}. Push it first; tasks never create branches.`,
      });
    }

    const plan = yield* loadSetupPlan(project);
    const baseBranch = yield* git
      .resolveDefaultBranchName(root, remoteName)
      .pipe(Effect.orElseSucceed(() => null));
    const taskId = TaskId.make(yield* uuid);
    const createdAt = yield* nowIso;
    const steps = planSetupSteps(remoteRef, plan).map((step) =>
      step.id === "fetch"
        ? {
            ...step,
            status: "done" as const,
            log: `Fetched ${remoteRef}`,
            startedAt: createdAt,
            finishedAt: createdAt,
          }
        : step,
    );
    let workspace: OrchestrationTaskWorkspace = {
      path: null,
      branch,
      remoteName,
      remoteBranch: branch,
      baseBranch: baseBranch === branch ? null : baseBranch,
      setup: { status: "running", steps, error: null, updatedAt: createdAt },
    };
    yield* dispatch({
      type: "task.create",
      commandId: yield* commandId("create"),
      taskId,
      projectId: project.id,
      title: input.title,
      description: input.description ?? null,
      workspace,
      autoHandleReviewFeedback: input.autoHandleReviewFeedback ?? false,
      autoHandleCIFailures: false,
      createdAt,
    });

    // The worktree is created inline so the first thread can open in it.
    // Copy rules and scripts run in the background afterwards.
    workspace = yield* runSteps(taskId, root, workspace, plan, new Set(["worktree"]));
    if (workspace.setup.status === "failed") {
      return yield* failed(workspace.setup.error ?? "Failed to create the worktree.");
    }

    const task = yield* requireActiveTask(taskId);
    const { threadId } = yield* createTaskThread(task, project, { origin: "user" });
    yield* forkSetup(taskId, root, workspace, plan);
    return { taskId, threadId };
  });

  /**
   * Reserve the task before the first yield: two retries racing past the
   * status check would otherwise both fork a setup.
   */
  const retrySetup: TaskWorkspaceService["Service"]["retrySetup"] = (taskId) =>
    Effect.suspend(() => {
      if (archiving.has(taskId)) return Effect.fail(archivingError());
      if (retrying.has(taskId) || setupFibers.has(taskId)) {
        return Effect.fail(failed("Only a failed setup can be retried."));
      }
      retrying.add(taskId);
      return retrySetupReserved(taskId).pipe(
        Effect.ensuring(Effect.sync(() => retrying.delete(taskId))),
      );
    });

  const retrySetupReserved = Effect.fn("TaskWorkspaceService.retrySetup")(function* (
    taskId: TaskId,
  ) {
    const task = yield* requireActiveTask(taskId);
    if (task.workspace.setup.status !== "failed") {
      return yield* failed("Only a failed setup can be retried.");
    }
    const project = yield* requireProject(task.projectId);
    const plan = yield* loadSetupPlan(project);
    const previous = new Map(task.workspace.setup.steps.map((step) => [step.id, step]));
    const worktreeMissing = task.workspace.path === null || !(yield* exists(task.workspace.path));
    // Re-plan so fixed copy rules and scripts apply. Steps that already
    // finished keep their result; the worktree reruns when it is gone.
    const steps = planSetupSteps(
      `${task.workspace.remoteName}/${task.workspace.remoteBranch}`,
      plan,
    ).map((step) => {
      const before = previous.get(step.id);
      if (step.id === "worktree" && worktreeMissing) return step;
      if (step.id === "fetch" && before === undefined) return { ...step, status: "done" as const };
      return before?.status === "done" || before?.status === "skipped" ? before : step;
    });
    const updatedAt = yield* nowIso;
    const workspace: OrchestrationTaskWorkspace = {
      ...task.workspace,
      setup: { status: "running", steps, error: null, updatedAt },
    };
    yield* syncWorkspace(taskId, workspace);
    yield* forkSetup(taskId, project.workspaceRoot, workspace, plan);
  });

  const createThread: TaskWorkspaceService["Service"]["createThread"] = Effect.fn(
    "TaskWorkspaceService.createThread",
  )(function* (input) {
    const task = yield* requireActiveTask(input.taskId);
    const project = yield* requireProject(task.projectId);
    return yield* createTaskThread(task, project, input);
  });

  const isAgentRunning = (thread: OrchestrationThreadShell) =>
    thread.session?.status === "running" ||
    thread.session?.status === "starting" ||
    thread.latestTurn?.state === "running";

  const gitBlockers = Effect.fn("TaskWorkspaceService.gitBlockers")(function* (
    workspacePath: string,
  ) {
    const blockers: Array<TaskArchiveBlocker> = [];
    const status = yield* gitOutput(workspacePath, "TaskWorkspaceService.archiveStatus", [
      "status",
      "--porcelain",
    ]);
    if (status.ok && status.stdout.trim().length > 0) blockers.push("uncommitted-changes");
    const ahead = yield* gitOutput(workspacePath, "TaskWorkspaceService.archiveAhead", [
      "rev-list",
      "--count",
      "@{upstream}..HEAD",
    ]);
    // Without an upstream, any commit that no remote has is unpushed.
    const unpushed = ahead.ok
      ? ahead
      : yield* gitOutput(workspacePath, "TaskWorkspaceService.archiveUnpushed", [
          "rev-list",
          "--count",
          "HEAD",
          "--not",
          "--remotes",
        ]);
    if (unpushed.ok && Number.parseInt(unpushed.stdout.trim(), 10) > 0) {
      blockers.push("unpushed-commits");
    }
    return blockers;
  });

  const checkTask = Effect.fn("TaskWorkspaceService.checkTask")(function* (
    task: OrchestrationTask,
  ) {
    const blockers: Array<TaskArchiveBlocker> = [];
    if (task.workspace.path !== null && (yield* exists(task.workspace.path))) {
      blockers.push(
        ...(yield* gitBlockers(task.workspace.path).pipe(
          Effect.mapError((error) =>
            failed(`Failed to inspect the worktree: ${errorDetail(error)}`, error),
          ),
        )),
      );
    }
    if (task.pullRequest?.state === "open" || task.pullRequest?.state === "draft") {
      blockers.push("pull-request-open");
    }
    const threads = yield* listTaskThreads(task.id);
    if (threads.some(isAgentRunning)) blockers.push("agent-running");
    return { blockers, threads };
  });

  const archiveCheck: TaskWorkspaceService["Service"]["archiveCheck"] = Effect.fn(
    "TaskWorkspaceService.archiveCheck",
  )(function* (taskId) {
    const task = yield* requireActiveTask(taskId);
    const { blockers } = yield* checkTask(task);
    return { blockers };
  });

  /** Stop what holds a thread's files open. Terminal history stays for the transcript. */
  const releaseThread = (thread: OrchestrationThreadShell) =>
    Effect.all(
      [
        providers.stopSession({ threadId: thread.id }).pipe(Effect.ignoreCause({ log: true })),
        terminals
          .close({ threadId: thread.id, deleteHistory: false })
          .pipe(Effect.ignoreCause({ log: true })),
      ],
      { discard: true },
    );

  const archiveThreads = Effect.fn("TaskWorkspaceService.archiveThreads")(function* (
    threads: ReadonlyArray<OrchestrationThreadShell>,
  ) {
    for (const thread of threads) {
      yield* dispatch({
        type: "thread.archive",
        commandId: yield* commandId("thread-archive"),
        threadId: thread.id,
      });
    }
  });

  /**
   * Marks the task as archiving synchronously, so createThread and retrySetup
   * refuse it from the first moment, and clears the mark however archive ends.
   */
  const archive: TaskWorkspaceService["Service"]["archive"] = (input) =>
    Effect.suspend(() => {
      if (archiving.has(input.taskId)) return Effect.fail(archivingError());
      archiving.add(input.taskId);
      return archiveTask(input).pipe(
        Effect.ensuring(Effect.sync(() => archiving.delete(input.taskId))),
      );
    });

  const archiveTask = Effect.fn("TaskWorkspaceService.archive")(function* (
    input: TaskArchiveInput,
  ) {
    const task = yield* requireTask(input.taskId);
    if (task.archivedAt !== null) return;
    const { blockers, threads } = yield* checkTask(task);
    if (blockers.length > 0 && input.force !== true) {
      return yield* new TaskOperationError({
        reason: "archive-blocked",
        message: `Archiving would lose work: ${blockers.join(", ")}.`,
        blockers,
      });
    }
    const setupFiber = setupFibers.get(task.id);
    if (setupFiber) yield* Fiber.interrupt(setupFiber);

    // Release everything that holds the worktree open.
    yield* Effect.forEach(threads, releaseThread, { discard: true, concurrency: 4 });

    const project = yield* requireProject(task.projectId);
    const root = project.workspaceRoot;
    const workspacePath = task.workspace.path;
    if (workspacePath !== null) {
      yield* withWorkspaceLease(
        workspacePath,
        Effect.gen(function* () {
          if (yield* exists(workspacePath)) {
            // Closing a terminal kills its process asynchronously, so files can
            // stay locked for a moment (notably on Windows).
            yield* git
              .removeWorktree({ cwd: root, path: workspacePath, force: true })
              .pipe(Effect.retry({ times: 4, schedule: Schedule.spaced("500 millis") }));
          }
          yield* git.pruneWorktrees({ cwd: root });
        }),
      ).pipe(
        Effect.mapError((error) =>
          failed(`Failed to remove the worktree: ${errorDetail(error)}`, error),
        ),
      );
    }

    // Re-list: a thread created while the worktree was being removed (for
    // example by the supervisor, before the archiving mark) is archived too.
    const current = yield* listTaskThreads(task.id);
    const late = current.filter((thread) => !threads.some((entry) => entry.id === thread.id));
    yield* Effect.forEach(late, releaseThread, { discard: true, concurrency: 4 });
    yield* archiveThreads(current);
    yield* dispatch({
      type: "task.archive",
      commandId: yield* commandId("archive"),
      taskId: task.id,
    });
    // Once the task is archived the decider refuses new threads, so this last
    // listing catches anything that landed between the two dispatches above.
    const stragglers = yield* listTaskThreads(task.id);
    yield* Effect.forEach(stragglers, releaseThread, { discard: true, concurrency: 4 });
    yield* archiveThreads(stragglers);
  });

  const awaitSetup: TaskWorkspaceService["Service"]["awaitSetup"] = (taskId) =>
    Effect.suspend(() => {
      const fiber = setupFibers.get(taskId);
      return fiber ? Fiber.await(fiber).pipe(Effect.asVoid) : Effect.void;
    });

  return TaskWorkspaceService.of({
    create,
    retrySetup,
    createThread,
    archiveCheck,
    archive,
    awaitSetup,
  });
});

export const layer = Layer.effect(TaskWorkspaceService, make);
