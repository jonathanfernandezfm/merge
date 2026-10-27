import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkTaskId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as GitManager from "../../git/GitManager.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { ServerActivation } from "../../serverActivation.ts";
import * as Settings from "../../serverSettings.ts";
import * as StorageCleanup from "../../storageCleanup.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as WorkTaskStore from "./WorkTaskStore.ts";

const LONG_AGO = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const NOW = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-1");
const codex = ProviderInstanceId.make("codex");

/** An idle single thread on `feature`, inactive for months. */
const thread = (worktreePath: string) =>
  ({
    id: ThreadId.make("thread-1"),
    projectId,
    title: "Thread",
    providerInstanceId: codex,
    modelSelection: { instanceId: codex, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath,
    branch: "feature",
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: ThreadId.make("thread-1"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    createdAt: LONG_AGO,
    updatedAt: LONG_AGO,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
  }) as OrchestrationV2ThreadShell;

const layerDatabase = Layer.effectDiscard(runMigrations()).pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

it.live("storage cleanup keeps a single-thread Work Task worktree that a rule would remove", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const store = yield* WorkTaskStore.WorkTaskStore;
    const repo = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "merge-cleanup-" }),
    );
    const run = (args: string[]) =>
      git.execute({ operation: "merge-cleanup-test", cwd: repo, args });
    yield* run(["init", "-b", "main"]);
    yield* run(["config", "user.email", "t@t.com"]);
    yield* run(["config", "user.name", "T"]);
    yield* run(["commit", "--allow-empty", "-m", "initial"]);
    yield* fs.makeDirectory(config.worktreesDir, { recursive: true });
    const worktree = `${config.worktreesDir}/feature`;
    yield* run(["worktree", "add", "-b", "feature", worktree]);
    const threads = [thread(worktree)];
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      storageCleanup: { ...DEFAULT_SERVER_SETTINGS.storageCleanup, worktreeAfterDays: 8 },
    };
    const context = yield* Layer.build(StorageCleanup.layer).pipe(
      Effect.provideService(Settings.ServerSettingsService, {
        getSettings: Effect.succeed(settings),
        subscribeChanges: Effect.succeed(Stream.empty),
      } as unknown as Settings.ServerSettingsService["Service"]),
      Effect.provideService(ProjectStore.ProjectStoreV2, {
        list: () => Effect.succeed([{ workspaceRoot: repo }]),
        listShells: () => Effect.succeed([{ id: projectId, workspaceRoot: repo }]),
      } as unknown as ProjectStore.ProjectStoreV2["Service"]),
      Effect.provideService(ProjectionStore.ProjectionStoreV2, {
        getShellSnapshot: () => Effect.succeed({ threads, archivedThreads: [] }),
        getThreadWorktreePaths: () =>
          Effect.succeed(threads.map((shell) => ({ threadId: shell.id, worktreePath: worktree }))),
        getThreadShell: () => Effect.succeed(threads[0]),
      } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
      Effect.provideService(ProviderSessionManager.ProviderSessionManagerV2, {
        isLive: () => Effect.succeed(false),
      } as unknown as ProviderSessionManager.ProviderSessionManagerV2["Service"]),
      Effect.provideService(Orchestrator.OrchestratorV2, {
        streamDomainEvents: Stream.empty,
      } as unknown as Orchestrator.OrchestratorV2["Service"]),
      Effect.provideService(GitManager.GitManager, {
        invalidateStatus: () => Effect.void,
      } as unknown as GitManager.GitManager["Service"]),
      Effect.provideService(TerminalManager.TerminalManager, {
        subscribeMetadata: () => Effect.succeed(() => {}),
      } as unknown as TerminalManager.TerminalManager["Service"]),
      Effect.provideService(ServerActivation, Effect.never),
    );
    const cleanup = Context.get(context, StorageCleanup.StorageCleanup);

    // Stored through the symlinked tmp path with a trailing slash, as a task row may be.
    yield* store.insert({
      id: WorkTaskId.make("task-1"),
      projectId,
      title: "Feature",
      description: null,
      workspace: {
        path: `${worktree}/`,
        branch: "feature",
        remoteName: "origin",
        remoteBranch: "feature",
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
    });
    const kept = yield* cleanup.runNow;
    expect(kept.entries[0]).toMatchObject({ outcome: "kept", reason: "Owned by a Work Task" });
    expect(yield* fs.exists(worktree)).toBe(true);

    // Archived tasks no longer own it, so the rule applies again.
    yield* store.update(WorkTaskId.make("task-1"), { archivedAt: NOW });
    const removed = yield* cleanup.runNow;
    expect(removed.entries[0]).toMatchObject({ outcome: "removed" });
    expect(yield* fs.exists(worktree)).toBe(false);
  }).pipe(
    Effect.provide(
      WorkTaskStore.layer.pipe(
        Layer.provideMerge(layerDatabase),
        Layer.provideMerge(GitVcsDriver.layer),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "merge-cleanup-" })),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);
