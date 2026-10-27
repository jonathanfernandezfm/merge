import {
  CommandId,
  DEFAULT_MODEL,
  type GitCommandError,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProviderInstanceId,
  WorkTaskId,
  WorkTaskOperationError,
  workTaskStatusInputs,
  workTaskThreadState,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type Project,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
  type VcsListRefsResult,
  type WorkTask,
  type WorkTaskArchiveBlocker,
  type WorkTaskArchiveCheckResult,
  type WorkTaskArchiveInput,
  type WorkTaskCreateInput,
  type WorkTaskCreateResult,
  type WorkTaskListBranchesInput,
  type WorkTaskSetAutoHandleInput,
  type WorkTaskSetWaitingInput,
  type WorkTaskSetupStep,
  type WorkTaskThreadOrigin,
  type WorkTaskWorkspace as WorkTaskWorkspaceState,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { withWorkspaceLease } from "../../workspace/workspaceLease.ts";
import {
  applyCopyRule,
  readCopyRules,
  type WorkTaskCopyRule,
  type WorkTaskStepOutcome,
} from "./copyRules.ts";
import { WorkTaskStore } from "./WorkTaskStore.ts";

/** Who starts the threads a call launches. The UI default is the user on the web client. */
export interface WorkTaskLauncher {
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
  /** An agent caller's ceiling; otherwise the project defaults apply. */
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
}

export interface WorkTaskCreateThreadOptions {
  readonly taskId: WorkTaskId;
  readonly title?: string | undefined;
  /** Defaults to `user`. Automated threads (review feedback) pass their own. */
  readonly origin?: WorkTaskThreadOrigin | undefined;
}

type Result<A> = Effect.Effect<A, WorkTaskOperationError>;

/** Work Task actions on the worktree and its threads. */
export class WorkTaskWorkspace extends Context.Service<
  WorkTaskWorkspace,
  {
    /**
     * Fetch, check out the existing branch in a worktree (never a new branch), apply copy rules,
     * then launch the first thread. A setup failure keeps the task so `retrySetup` can resume it.
     */
    readonly create: (
      input: WorkTaskCreateInput,
      launcher?: WorkTaskLauncher,
    ) => Result<WorkTaskCreateResult>;
    /** Reruns setup from its first unfinished step, then opens the first thread if none exists. */
    readonly retrySetup: (taskId: WorkTaskId) => Result<void>;
    readonly createThread: (
      input: WorkTaskCreateThreadOptions,
      launcher?: WorkTaskLauncher,
    ) => Result<{ readonly threadId: ThreadId }>;
    /** What archiving would lose. Fails with `not-found` or `archived`. */
    readonly archiveCheck: (taskId: WorkTaskId) => Result<WorkTaskArchiveCheckResult>;
    /** Stops and archives the threads and removes the worktree. The branch stays. */
    readonly archive: (input: WorkTaskArchiveInput) => Result<void>;
    readonly setWaiting: (input: WorkTaskSetWaitingInput) => Result<void>;
    readonly setAutoHandle: (input: WorkTaskSetAutoHandleInput) => Result<void>;
    /** Fetches the project's primary remote first, so freshly pushed branches show up. */
    readonly listBranches: (input: WorkTaskListBranchesInput) => Result<VcsListRefsResult>;
  }
>()("t3/merge/workTasks/WorkTaskWorkspace") {}

const USER_LAUNCHER: WorkTaskLauncher = { createdBy: "user", creationSource: "web" };
/** Step logs keep a tail; the stored step schema caps them at 16 000 characters. */
const STEP_LOG_MAX_CHARS = 8_000;

const tail = (log: string) =>
  log.length <= STEP_LOG_MAX_CHARS ? log : `…${log.slice(log.length - STEP_LOG_MAX_CHARS + 1)}`;

const detail = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    for (const key of ["detail", "message"] as const) {
      const value = (error as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return "unknown error";
};

const failed = (message: string, cause?: unknown) =>
  new WorkTaskOperationError({
    reason: "failed",
    message: message.trim() || "Work Task operation failed.",
    ...(cause === undefined ? {} : { cause }),
  });

const copyStepId = (rule: WorkTaskCopyRule) => `copy:${rule.from}`;

const pendingStep = (id: string, label: string): WorkTaskSetupStep => ({
  id,
  label,
  status: "pending",
  log: null,
});

/** Run order: fetch, worktree, then one step per copy rule. The setup script runs in the first thread. */
const planSteps = (remoteRef: string, rules: ReadonlyArray<WorkTaskCopyRule>) => [
  pendingStep("fetch", `Fetch ${remoteRef}`),
  pendingStep("worktree", "Create worktree"),
  ...rules.map((rule) =>
    pendingStep(
      copyStepId(rule),
      rule.to && rule.to !== rule.from ? `Copy ${rule.from} to ${rule.to}` : `Copy ${rule.from}`,
    ),
  ),
];

const withStep = (
  workspace: WorkTaskWorkspaceState,
  stepId: string,
  patch: Partial<WorkTaskSetupStep>,
  updatedAt: string,
): WorkTaskWorkspaceState => ({
  ...workspace,
  setup: {
    ...workspace.setup,
    updatedAt,
    steps: workspace.setup.steps.map((step) => (step.id === stepId ? { ...step, ...patch } : step)),
  },
});

/** @public */
export const make = Effect.gen(function* () {
  const store = yield* WorkTaskStore;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitWorkflow = yield* GitWorkflow.GitWorkflowService;
  const projects = yield* ProjectService.ProjectService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const terminals = yield* TerminalManager.TerminalManager;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  /**
   * One lock per task: setup, retry, thread launch and archive never overlap, so a thread can
   * never land in a worktree that archive is removing. shortcut: locks are never evicted; one
   * small semaphore per task ever touched in this process.
   */
  const locks = new Map<WorkTaskId, Semaphore.Semaphore>();
  const exclusive = <A, E, R>(taskId: WorkTaskId, effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      const lock = locks.get(taskId) ?? Semaphore.makeUnsafe(1);
      locks.set(taskId, lock);
      return lock.withPermit(effect);
    });

  const uuid = crypto.randomUUIDv4().pipe(Effect.orDie);
  const commandId = (tag: string) =>
    uuid.pipe(Effect.map((id) => CommandId.make(`merge:work-task-${tag}:${id}`)));
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const withFs = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  const exists = (target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => false));
  const real = (target: string) =>
    fs.realPath(target).pipe(Effect.orElseSucceed(() => path.resolve(target)));
  const gitOut = (operation: string, cwd: string, args: ReadonlyArray<string>) =>
    git
      .execute({ operation, cwd, args, allowNonZeroExit: true })
      .pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)));

  const requireTask = Effect.fn("WorkTaskWorkspace.requireTask")(function* (taskId: WorkTaskId) {
    const task = yield* store.get(taskId);
    if (task === null) {
      return yield* new WorkTaskOperationError({
        reason: "not-found",
        message: `Work Task '${taskId}' was not found.`,
      });
    }
    return task;
  });

  const requireActiveTask = Effect.fn("WorkTaskWorkspace.requireActiveTask")(function* (
    taskId: WorkTaskId,
  ) {
    const task = yield* requireTask(taskId);
    if (task.archivedAt !== null) {
      return yield* new WorkTaskOperationError({
        reason: "archived",
        message: `Work Task '${task.title}' is archived.`,
      });
    }
    return task;
  });

  const requireProject = Effect.fn("WorkTaskWorkspace.requireProject")(function* (
    projectId: WorkTask["projectId"],
  ) {
    const project = yield* projects
      .getById(projectId)
      .pipe(Effect.mapError((cause) => failed("Could not read the project.", cause)));
    if (Option.isNone(project)) {
      return yield* new WorkTaskOperationError({
        reason: "not-found",
        message: `Project '${projectId}' was not found.`,
      });
    }
    return project.value;
  });

  /** Which worktree (the main checkout included) has `branch` checked out, if any. */
  const findCheckout = Effect.fn("WorkTaskWorkspace.findCheckout")(function* (
    root: string,
    branch: string,
  ) {
    const list = yield* gitOut("WorkTaskWorkspace.listWorktrees", root, [
      "worktree",
      "list",
      "--porcelain",
    ]);
    let current: string | null = null;
    for (const line of (list ?? "").split(/\r?\n/)) {
      if (line.startsWith("worktree ")) current = line.slice("worktree ".length);
      if (line === `branch refs/heads/${branch}`) return current ?? root;
    }
    return null;
  });

  /**
   * Brings an existing local branch up to its remote before checking it out: fast-forwards when
   * behind and keeps local commits otherwise. Returns the line for the worktree step log.
   */
  const syncLocalBranch = Effect.fn("WorkTaskWorkspace.syncLocalBranch")(function* (
    root: string,
    workspace: WorkTaskWorkspaceState,
  ) {
    const { branch, remoteName, remoteBranch } = workspace;
    const localRef = `refs/heads/${branch}`;
    const remoteRef = `refs/remotes/${remoteName}/${remoteBranch}`;
    const remoteLabel = `${remoteName}/${remoteBranch}`;
    const verify = (ref: string) =>
      gitOut("WorkTaskWorkspace.branchHead", root, ["rev-parse", "--verify", "--quiet", ref]);
    const local = yield* verify(localRef);
    const remote = yield* verify(remoteRef);
    if (local === null || remote === null) {
      return `Reusing local branch ${branch}; could not compare it with ${remoteLabel}`;
    }
    if (local === remote) return `Reusing local branch ${branch}, up to date with ${remoteLabel}`;
    const isAncestor = (ancestor: string, of: string) =>
      gitOut("WorkTaskWorkspace.isAncestor", root, ["merge-base", "--is-ancestor", ancestor, of]);
    if ((yield* isAncestor(localRef, remoteRef)) !== null) {
      yield* git.execute({
        operation: "WorkTaskWorkspace.fastForwardLocalBranch",
        cwd: root,
        args: ["branch", "-f", "--", branch, remoteRef],
      });
      return `Fast-forwarded local branch ${branch} to ${remoteLabel}`;
    }
    return (yield* isAncestor(remoteRef, localRef)) !== null
      ? `Note: local branch ${branch} has commits that are not on ${remoteLabel}. Kept the local branch; push them when ready.`
      : `Note: local branch ${branch} has diverged from ${remoteLabel}. Kept the local branch as is; reconcile it with the remote before pushing.`;
  });

  /**
   * Checks out the existing branch in a worktree: reuses local `branch` when it exists, otherwise
   * creates it tracking `remoteName/remoteBranch`. Never creates a branch under any other name.
   */
  const ensureWorktree = Effect.fn("WorkTaskWorkspace.ensureWorktree")(function* (
    root: string,
    workspace: WorkTaskWorkspaceState,
  ) {
    const { branch, remoteName, remoteBranch } = workspace;
    if (workspace.path !== null && (yield* exists(workspace.path))) {
      return { path: workspace.path, log: `Reusing ${workspace.path}` };
    }
    // A worktree deleted outside the app leaves a registration that blocks `worktree add`.
    yield* git.pruneWorktrees({ cwd: root });
    const checkout = yield* findCheckout(root, branch);
    if (checkout !== null) {
      return yield* failed(
        `Branch '${branch}' is already checked out at ${checkout}. Switch that checkout to another branch, then retry.`,
      );
    }
    const local = (yield* git.listLocalBranchNames(root)).includes(branch);
    const onRemote = yield* git.remoteBranchExists({
      cwd: root,
      remoteName,
      refName: remoteBranch,
    });
    const log: Array<string> = [];
    if (local && !onRemote) {
      log.push(`Using local branch ${branch}; it is not on ${remoteName} yet`);
    } else if (local) {
      log.push(yield* syncLocalBranch(root, workspace));
    } else {
      yield* git.execute({
        operation: "WorkTaskWorkspace.trackRemoteBranch",
        cwd: root,
        args: ["branch", "--track", "--", branch, `refs/remotes/${remoteName}/${remoteBranch}`],
      });
      log.push(`Created local branch ${branch} tracking ${remoteName}/${remoteBranch}`);
    }
    // No newRefName: the worktree checks out `branch` itself.
    const created = yield* gitWorkflow.createWorktree({
      cwd: root,
      refName: branch,
      path: workspace.path,
    });
    if (onRemote) yield* git.setBranchUpstream({ cwd: root, branch, remoteName, remoteBranch });
    log.push(`Checked out ${branch} at ${created.worktree.path}`);
    return { path: created.worktree.path, log: log.join("\n") };
  });

  /** A name git would read as an option, or not a valid branch name, never reaches git. */
  const requireValidBranchName = Effect.fn("WorkTaskWorkspace.requireValidBranchName")(function* (
    root: string,
    branch: string,
  ) {
    const valid =
      !branch.startsWith("-") &&
      (yield* gitOut("WorkTaskWorkspace.checkBranchName", root, [
        "check-ref-format",
        "--branch",
        branch,
      ])) !== null;
    if (!valid) {
      return yield* new WorkTaskOperationError({
        reason: "invalid-branch",
        message: `'${branch}' is not a valid branch name.`,
      });
    }
  });

  /** Two live tasks on one branch would let archiving either delete the other's worktree. */
  const requireBranchUnowned = Effect.fn("WorkTaskWorkspace.requireBranchUnowned")(function* (
    projectId: WorkTask["projectId"],
    branch: string,
  ) {
    const owner = (yield* store.list()).find(
      (task) =>
        task.projectId === projectId &&
        task.archivedAt === null &&
        task.workspace.branch === branch,
    );
    if (owner !== undefined) {
      return yield* failed(`Branch '${branch}' already belongs to Work Task '${owner.title}'.`);
    }
  });

  /**
   * Checked before the task exists, so a branch held by another worktree fails cleanly. The
   * caller may ask to detach that worktree in place; the project's own checkout is never touched.
   */
  const detachExistingCheckout = Effect.fn("WorkTaskWorkspace.detachExistingCheckout")(function* (
    root: string,
    branch: string,
    detachCheckoutAt: string | undefined,
  ) {
    yield* git.pruneWorktrees({ cwd: root });
    const checkout = yield* findCheckout(root, branch);
    if (checkout === null) return;
    if ((yield* real(checkout)) === (yield* real(root))) {
      return yield* failed(
        `Branch '${branch}' is checked out in the project's main checkout. Switch it to another branch, then retry.`,
      );
    }
    if (
      detachCheckoutAt === undefined ||
      (yield* real(detachCheckoutAt)) !== (yield* real(checkout))
    ) {
      return yield* new WorkTaskOperationError({
        reason: "branch-checked-out",
        message: `Branch '${branch}' is already checked out at ${checkout}.`,
        checkoutPath: checkout,
      });
    }
    yield* git.execute({
      operation: "WorkTaskWorkspace.detachCheckout",
      cwd: checkout,
      args: ["switch", "--detach"],
    });
    yield* Effect.logInfo("Work Task creation detached an existing checkout", { branch, checkout });
  });

  /** A worktree handed in must hold `branch` for this project and must not be the main checkout. */
  const requireAdoptableWorktree = Effect.fn("WorkTaskWorkspace.requireAdoptableWorktree")(
    function* (root: string, branch: string, worktreePath: string) {
      yield* git.pruneWorktrees({ cwd: root });
      const checkout = yield* findCheckout(root, branch);
      const target = yield* real(worktreePath);
      if (checkout === null || (yield* real(checkout)) !== target) {
        return yield* failed(
          `${worktreePath} is not a worktree of this project with '${branch}' checked out.`,
        );
      }
      if (target === (yield* real(root))) {
        return yield* failed(
          `${worktreePath} is the project's main checkout; a Work Task needs its own worktree.`,
        );
      }
      return checkout;
    },
  );

  const runStep = (
    root: string,
    workspace: WorkTaskWorkspaceState,
    stepId: string,
    rules: ReadonlyArray<WorkTaskCopyRule>,
  ): Effect.Effect<
    WorkTaskStepOutcome & { readonly path?: string },
    GitCommandError | WorkTaskOperationError
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
      return Effect.succeed({ status: "failed", log: null, error: "The task has no worktree." });
    }
    const rule = rules.find((entry) => copyStepId(entry) === stepId);
    if (rule) return withFs(applyCopyRule(root, workspace.path, rule));
    return Effect.succeed({
      status: "skipped",
      log: "This step is no longer configured.",
    } as const);
  };

  /**
   * Runs every unfinished step in order, writing each start and outcome through the store's
   * serialized `updateWorkspace`. The first failure marks setup failed and stops.
   */
  const runSetup = Effect.fn("WorkTaskWorkspace.runSetup")(function* (
    taskId: WorkTaskId,
    root: string,
    rules: ReadonlyArray<WorkTaskCopyRule>,
  ) {
    let task = yield* requireTask(taskId);
    for (const step of task.workspace.setup.steps) {
      if (step.status === "done" || step.status === "skipped") continue;
      const startedAt = yield* nowIso;
      task = yield* store.updateWorkspace(taskId, (workspace) =>
        withStep(
          workspace,
          step.id,
          { status: "running", log: null, startedAt, finishedAt: null },
          startedAt,
        ),
      );
      const outcome = yield* runStep(root, task.workspace, step.id, rules).pipe(
        Effect.catch((error) =>
          Effect.succeed({ status: "failed", log: null, error: detail(error) } as const),
        ),
      );
      const finishedAt = yield* nowIso;
      task = yield* store.updateWorkspace(taskId, (workspace) => {
        const next = withStep(
          "path" in outcome && outcome.path !== undefined
            ? { ...workspace, path: outcome.path }
            : workspace,
          step.id,
          {
            status: outcome.status,
            log:
              outcome.log === null
                ? outcome.status === "failed"
                  ? outcome.error
                  : null
                : tail(outcome.log),
            finishedAt,
          },
          finishedAt,
        );
        return outcome.status === "failed"
          ? { ...next, setup: { ...next.setup, status: "failed", error: outcome.error } }
          : next;
      });
      if (outcome.status === "failed") return yield* failed(outcome.error);
    }
    const readyAt = yield* nowIso;
    return yield* store.updateWorkspace(taskId, (workspace) => ({
      ...workspace,
      setup: { ...workspace.setup, status: "ready", error: null, updatedAt: readyAt },
    }));
  });

  const launchThread = Effect.fn("WorkTaskWorkspace.launchThread")(function* (
    task: WorkTask,
    project: Project,
    options: Omit<WorkTaskCreateThreadOptions, "taskId">,
    launcher: WorkTaskLauncher,
    /** Only a task's first thread runs the project setup script; later ones share its result. */
    first: boolean,
  ) {
    const worktreePath = task.workspace.path;
    if (worktreePath === null || task.workspace.setup.status !== "ready") {
      return yield* failed("The Work Task worktree is not ready. Retry its setup first.");
    }
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError((cause) => failed("Could not read settings.", cause)),
    );
    const defaults = resolveProjectSettings(settings, project.id, project).settings;
    const launched = yield* launches
      .launch({
        commandId: yield* commandId("thread"),
        projectId: project.id,
        // The default title lets upstream name the thread from its first message.
        title: options.title?.trim() || "New thread",
        modelSelection: defaults.defaultModelSelection ?? {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_MODEL,
        },
        runtimeMode: launcher.runtimeMode ?? defaults.defaultRuntimeMode,
        interactionMode: launcher.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
        workspaceStrategy: {
          type: "existing_worktree",
          worktreePath,
          branch: task.workspace.branch,
          ...(first ? {} : { skipSetupScript: true }),
        },
        createdBy: launcher.createdBy,
        creationSource: launcher.creationSource,
      })
      .pipe(
        Effect.mapError((cause) => failed(`Could not start the thread: ${detail(cause)}`, cause)),
      );
    yield* store.link(launched.threadId, task.id, options.origin ?? "user");
    return { threadId: launched.threadId };
  });

  const gitBlockers = Effect.fn("WorkTaskWorkspace.gitBlockers")(function* (cwd: string) {
    const blockers: Array<WorkTaskArchiveBlocker> = [];
    if (yield* gitOut("WorkTaskWorkspace.archiveStatus", cwd, ["status", "--porcelain"])) {
      blockers.push("uncommitted-changes");
    }
    // Without an upstream, any commit that no remote has is unpushed.
    const ahead =
      (yield* gitOut("WorkTaskWorkspace.archiveAhead", cwd, [
        "rev-list",
        "--count",
        "@{upstream}..HEAD",
      ])) ??
      (yield* gitOut("WorkTaskWorkspace.archiveUnpushed", cwd, [
        "rev-list",
        "--count",
        "HEAD",
        "--not",
        "--remotes",
      ]));
    if (ahead !== null && Number.parseInt(ahead, 10) > 0) blockers.push("unpushed-commits");
    return blockers;
  });

  /** The blockers, plus the task's linked thread shells that archive must stop and archive. */
  const inspect = Effect.fn("WorkTaskWorkspace.inspect")(function* (task: WorkTask) {
    const blockers: Array<WorkTaskArchiveBlocker> = [];
    const worktreePath = task.workspace.path;
    if (worktreePath !== null && (yield* exists(worktreePath))) {
      blockers.push(
        ...(yield* gitBlockers(worktreePath).pipe(
          Effect.mapError((cause) => failed("Could not inspect the worktree.", cause)),
        )),
      );
    }
    const links = (yield* store.links()).filter((link) => link.taskId === task.id);
    // Async subagent children can outlive their parent's run, so they are read too;
    // workTaskStatusInputs keeps only the ones rooted in this task's threads.
    const shells = (yield* Effect.gen(function* () {
      const subagents = yield* projections.listActiveSubagentThreadIds();
      const ids = [...links.map((link) => link.threadId), ...subagents];
      return yield* Effect.forEach(ids, (id) => projections.getThreadShell(id), {
        concurrency: 8,
      });
    }).pipe(
      Effect.mapError((cause) => failed("Could not read the Work Task threads.", cause)),
    )).filter((shell): shell is OrchestrationV2ThreadShell => shell !== null);
    const { threads, pullRequest } = workTaskStatusInputs({ taskId: task.id, task, links, shells });
    if (pullRequest?.state === "open" || pullRequest?.state === "draft") {
      blockers.push("pull-request-open");
    }
    if (threads.some((thread) => thread.state === "running" || thread.state === "waiting")) {
      blockers.push("agent-running");
    }
    const linked = new Set(links.map((link) => link.threadId));
    const live = shells.filter(
      (shell) => linked.has(shell.id) && shell.archivedAt === null && shell.deletedAt === null,
    );
    const descendants = shells.filter(
      (shell) =>
        shell.lineage.relationshipToParent === "subagent" &&
        linked.has(shell.lineage.rootThreadId) &&
        shell.deletedAt === null,
    );
    return { blockers, live, descendants };
  });

  const dispatchQuietly = (command: OrchestrationV2ServerCommand) =>
    orchestrator.dispatch(command).pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Effect.logWarning(`Work Task archive could not ${command.type}`, { cause }),
      ),
    );

  /** True while any of the threads still has a live run. */
  const anyRunning = (threadIds: ReadonlyArray<ThreadId>) =>
    Effect.forEach(threadIds, (id) => projections.getThreadShell(id), { concurrency: 8 }).pipe(
      Effect.map((shells) =>
        shells.some((shell) => shell !== null && workTaskThreadState(shell) === "running"),
      ),
      Effect.orElseSucceed(() => false),
    );

  const create = Effect.fn("WorkTaskWorkspace.create")(function* (
    input: WorkTaskCreateInput,
    launcher: WorkTaskLauncher = USER_LAUNCHER,
  ) {
    const project = yield* requireProject(input.projectId);
    const root = project.workspaceRoot;
    const branch = input.branch.trim();
    const gitFailed = (error: unknown) => failed(detail(error), error);
    yield* requireValidBranchName(root, branch).pipe(
      Effect.catchTags({ GitCommandError: gitFailed }),
    );
    const remoteName =
      input.remoteName ??
      (yield* git.resolvePrimaryRemoteName(root).pipe(Effect.orElseSucceed(() => "origin")));
    if (
      remoteName.startsWith("-") ||
      (input.remoteName !== undefined &&
        !(yield* git.remoteExists({ cwd: root, remoteName }).pipe(Effect.mapError(gitFailed))))
    ) {
      return yield* new WorkTaskOperationError({
        reason: "invalid-branch",
        message: `'${remoteName}' is not a remote of this project.`,
      });
    }
    const isLocal = (yield* git
      .listLocalBranchNames(root)
      .pipe(Effect.mapError(gitFailed))).includes(branch);
    // A local branch does not need the remote, so a failed fetch only fails one that does.
    const fetched = yield* git.fetchRemote({ cwd: root, remoteName, refName: branch }).pipe(
      Effect.as(true),
      Effect.catchTags({
        GitCommandError: (error) =>
          isLocal
            ? Effect.succeed(false)
            : Effect.fail(failed(`Could not fetch ${remoteName}: ${detail(error)}`, error)),
      }),
    );
    const onRemote = yield* git
      .remoteBranchExists({ cwd: root, remoteName, refName: branch })
      .pipe(Effect.mapError(gitFailed));
    if (!onRemote && !isLocal) {
      return yield* new WorkTaskOperationError({
        reason: "remote-branch-missing",
        message: `Branch '${branch}' does not exist locally or on ${remoteName}. Work Tasks never create branches.`,
      });
    }
    yield* requireBranchUnowned(project.id, branch);
    const adoptedPath =
      input.worktreePath === undefined
        ? null
        : yield* requireAdoptableWorktree(root, branch, input.worktreePath).pipe(
            Effect.catchTags({ GitCommandError: gitFailed }),
          );
    if (adoptedPath === null) {
      yield* detachExistingCheckout(root, branch, input.detachCheckoutAt).pipe(
        Effect.catchTags({ GitCommandError: gitFailed }),
      );
    }

    const rules = yield* withFs(readCopyRules(root));
    const baseBranch = yield* git
      .resolveDefaultBranchName(root, remoteName)
      .pipe(Effect.orElseSucceed(() => null));
    const taskId = WorkTaskId.make(yield* uuid);
    const createdAt = yield* nowIso;
    const remoteRef = `${remoteName}/${branch}`;
    const steps = planSteps(remoteRef, rules).map((step) =>
      step.id === "fetch"
        ? {
            ...step,
            status: fetched ? ("done" as const) : ("skipped" as const),
            log: fetched
              ? `Fetched ${remoteRef}`
              : `Could not fetch ${remoteName}; using local ${branch}`,
            startedAt: createdAt,
            finishedAt: createdAt,
          }
        : step,
    );
    yield* store.insert({
      id: taskId,
      projectId: project.id,
      title: input.title,
      description: input.description ?? null,
      workspace: {
        path: adoptedPath,
        branch,
        remoteName,
        remoteBranch: branch,
        baseBranch: baseBranch === branch ? null : baseBranch,
        setup: { status: "running", steps, error: null, updatedAt: createdAt },
      },
      legacyPullRequest: null,
      autoHandleReviewFeedback: input.autoHandleReviewFeedback ?? false,
      waitingForUserReason: null,
      createdAt,
      updatedAt: createdAt,
      mergedAt: null,
      archivedAt: null,
      deletedAt: null,
    });
    return yield* exclusive(
      taskId,
      Effect.gen(function* () {
        const task = yield* runSetup(taskId, root, rules);
        const { threadId } = yield* launchThread(task, project, { origin: "user" }, launcher, true);
        return { taskId, threadId };
      }),
    );
  });

  const retrySetup = (taskId: WorkTaskId) =>
    exclusive(
      taskId,
      Effect.gen(function* () {
        const task = yield* requireActiveTask(taskId);
        // Under the lock a `running` setup was cut off by a restart, so it may resume too.
        if (task.workspace.setup.status === "ready") {
          return yield* failed("Only a failed setup can be retried.");
        }
        const project = yield* requireProject(task.projectId);
        const rules = yield* withFs(readCopyRules(project.workspaceRoot));
        const previous = new Map(task.workspace.setup.steps.map((step) => [step.id, step]));
        const worktreeMissing =
          task.workspace.path === null || !(yield* exists(task.workspace.path));
        // Re-plan so fixed copy rules apply. Finished steps keep their result; the worktree
        // step reruns when its directory is gone.
        const steps = planSteps(
          `${task.workspace.remoteName}/${task.workspace.remoteBranch}`,
          rules,
        ).map((step) => {
          const before = previous.get(step.id);
          if (step.id === "worktree" && worktreeMissing) return step;
          return before?.status === "done" || before?.status === "skipped" ? before : step;
        });
        const updatedAt = yield* nowIso;
        yield* store.updateWorkspace(taskId, (workspace) => ({
          ...workspace,
          setup: { status: "running", steps, error: null, updatedAt },
        }));
        const ready = yield* runSetup(taskId, project.workspaceRoot, rules);
        if (!(yield* store.links()).some((link) => link.taskId === taskId)) {
          yield* launchThread(ready, project, { origin: "user" }, USER_LAUNCHER, true);
        }
      }),
    ).pipe(Effect.withSpan("WorkTaskWorkspace.retrySetup"));

  const createThread = (
    input: WorkTaskCreateThreadOptions,
    launcher: WorkTaskLauncher = USER_LAUNCHER,
  ) =>
    exclusive(
      input.taskId,
      Effect.gen(function* () {
        const task = yield* requireActiveTask(input.taskId);
        const project = yield* requireProject(task.projectId);
        return yield* launchThread(task, project, input, launcher, false);
      }),
    ).pipe(Effect.withSpan("WorkTaskWorkspace.createThread"));

  const archiveCheck = Effect.fn("WorkTaskWorkspace.archiveCheck")(function* (taskId: WorkTaskId) {
    const { blockers } = yield* inspect(yield* requireActiveTask(taskId));
    return { blockers };
  });

  const archive = (input: WorkTaskArchiveInput) =>
    exclusive(
      input.taskId,
      Effect.gen(function* () {
        const task = yield* requireTask(input.taskId);
        if (task.archivedAt !== null) return;
        const { blockers, live, descendants } = yield* inspect(task);
        if (blockers.length > 0 && input.force !== true) {
          return yield* new WorkTaskOperationError({
            reason: "archive-blocked",
            message: `Archiving would lose work: ${blockers.join(", ")}.`,
            blockers,
          });
        }
        // Release what holds the worktree open; terminal history stays for the transcript.
        const holders = [...live, ...descendants];
        for (const shell of holders) {
          yield* dispatchQuietly({
            type: "thread.stop",
            commandId: yield* commandId("stop"),
            threadId: shell.id,
            reason: "Work Task archived.",
          });
          yield* terminals
            .close({ threadId: shell.id, deleteHistory: false })
            .pipe(Effect.ignoreCause({ log: true }));
        }
        // Stopping is asynchronous: give runs a few seconds to end before files go away.
        const holderIds = holders.map((shell) => shell.id);
        for (let attempt = 0; attempt < 10 && (yield* anyRunning(holderIds)); attempt++) {
          yield* Effect.sleep("300 millis");
        }
        if (yield* anyRunning(holderIds)) {
          yield* Effect.logWarning(
            "Work Task archive removes the worktree while a run is still stopping",
            {
              taskId: task.id,
            },
          );
        }
        const force = input.force === true;
        const worktreePath = task.workspace.path;
        if (worktreePath !== null) {
          const root = (yield* requireProject(task.projectId)).workspaceRoot;
          yield* withWorkspaceLease(
            worktreePath,
            Effect.gen(function* () {
              if (yield* exists(worktreePath)) {
                // Closed terminals exit asynchronously and can hold files for a moment.
                yield* git
                  .removeWorktree({ cwd: root, path: worktreePath, force })
                  .pipe(
                    Effect.retry({ times: force ? 4 : 0, schedule: Schedule.spaced("500 millis") }),
                  );
              }
              yield* git.pruneWorktrees({ cwd: root });
            }),
          ).pipe(
            Effect.mapError((cause) =>
              failed(
                force
                  ? `Could not remove the worktree: ${detail(cause)}`
                  : `Git refused to remove the worktree: ${detail(cause)} Archive anyway to force it.`,
                cause,
              ),
            ),
          );
        }
        const notArchived: Array<{ readonly threadId: ThreadId; readonly cause: unknown }> = [];
        for (const shell of live) {
          yield* orchestrator
            .dispatch({
              type: "thread.archive",
              commandId: yield* commandId("archive"),
              threadId: shell.id,
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() => void notArchived.push({ threadId: shell.id, cause })),
              ),
            );
        }
        if (notArchived.length > 0) {
          yield* Effect.logWarning("Work Task archive could not archive some threads", {
            taskId: task.id,
            threads: notArchived,
          });
        }
        yield* store.update(task.id, { archivedAt: yield* nowIso });
      }),
    ).pipe(Effect.withSpan("WorkTaskWorkspace.archive"));

  const setWaiting = Effect.fn("WorkTaskWorkspace.setWaiting")(function* (
    input: WorkTaskSetWaitingInput,
  ) {
    yield* requireActiveTask(input.taskId);
    yield* store.update(input.taskId, { waitingForUserReason: input.reason });
  });

  const setAutoHandle = Effect.fn("WorkTaskWorkspace.setAutoHandle")(function* (
    input: WorkTaskSetAutoHandleInput,
  ) {
    yield* requireActiveTask(input.taskId);
    yield* store.update(input.taskId, { autoHandleReviewFeedback: input.enabled });
  });

  const listBranches = Effect.fn("WorkTaskWorkspace.listBranches")(function* (
    input: WorkTaskListBranchesInput,
  ) {
    const { projectId, ...listInput } = input;
    const root = (yield* requireProject(projectId)).workspaceRoot;
    // Offline still lists what is known locally.
    yield* git.resolvePrimaryRemoteName(root).pipe(
      Effect.flatMap((remoteName) => git.fetchRemote({ cwd: root, remoteName })),
      Effect.ignore,
    );
    return yield* git
      .listRefs({ ...listInput, cwd: root, refresh: true })
      .pipe(Effect.mapError((cause) => failed(detail(cause), cause)));
  });

  return WorkTaskWorkspace.of({
    create,
    retrySetup,
    createThread,
    archiveCheck,
    archive,
    setWaiting,
    setAutoHandle,
    listBranches,
  });
});

export const layer = Layer.effect(WorkTaskWorkspace, make);
