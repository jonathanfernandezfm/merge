import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  TaskId,
  ThreadId,
  type OrchestrationTaskWorkspace,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-tasks");
const TASK_ID = TaskId.make("task-1");
const THREAD_ID = ThreadId.make("thread-in-task");

const workspace: OrchestrationTaskWorkspace = {
  path: "/tmp/project-tasks/.worktrees/widgets",
  branch: "feature/widgets",
  remoteName: "origin",
  remoteBranch: "feature/widgets",
  baseBranch: "main",
  setup: {
    status: "running",
    steps: [
      { id: "copy", label: "Copy files", status: "done", log: "copied .env", startedAt: NOW },
    ],
    error: null,
    updatedAt: NOW,
  },
};

const makeOrchestrationLayer = (databasePath: string) =>
  Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(makeSqlitePersistenceLive(databasePath)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-task-projection-" })),
    Layer.provideMerge(NodeServices.layer),
  );

it.layer(NodeServices.layer)("task projection", (it) => {
  it.effect("persists tasks and thread task links across a restart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-task-projection-",
        });
        const databasePath = path.join(directory, "state.sqlite");

        yield* Effect.gen(function* () {
          const engine = yield* OrchestrationEngineService;
          yield* engine.dispatch({
            type: "project.create",
            commandId: CommandId.make("cmd-project"),
            projectId: PROJECT_ID,
            title: "Tasks",
            workspaceRoot: "/tmp/project-tasks",
            createdAt: NOW,
          });
          yield* engine.dispatch({
            type: "task.create",
            commandId: CommandId.make("cmd-task"),
            taskId: TASK_ID,
            projectId: PROJECT_ID,
            title: "Widgets",
            description: "Add widgets",
            workspace,
            autoHandleReviewFeedback: true,
            autoHandleCIFailures: false,
            createdAt: NOW,
          });
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("cmd-thread"),
            threadId: THREAD_ID,
            projectId: PROJECT_ID,
            title: "Thread",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: workspace.branch,
            worktreePath: workspace.path,
            taskId: TASK_ID,
            origin: "review-feedback",
            createdAt: NOW,
          });
        }).pipe(Effect.provide(makeOrchestrationLayer(databasePath)));

        // A restart rebuilds the engine read model from projections, so the
        // task must still exist for the decider.
        yield* Effect.gen(function* () {
          const engine = yield* OrchestrationEngineService;
          yield* engine.dispatch({
            type: "task.meta.update",
            commandId: CommandId.make("cmd-meta"),
            taskId: TASK_ID,
            waitingForUserReason: "Pick a base branch",
          });

          const snapshotQuery = yield* ProjectionSnapshotQuery;
          const task = Option.getOrThrow(yield* snapshotQuery.getTaskById(TASK_ID));
          expect(task).toMatchObject({
            title: "Widgets",
            description: "Add widgets",
            workspace,
            pullRequest: null,
            autoHandleReviewFeedback: true,
            autoHandleCIFailures: false,
            waitingForUserReason: "Pick a base branch",
            archivedAt: null,
          });

          const shell = yield* snapshotQuery.getShellSnapshot();
          expect(shell.tasks?.map((entry) => entry.id)).toEqual([TASK_ID]);
          // The shell drops logs of steps that did not fail; the read model keeps them.
          expect(shell.tasks?.[0]?.workspace.setup.steps[0]?.log).toBeNull();
          expect(task.workspace.setup.steps[0]?.log).toBe("copied .env");
          const threadShell = shell.threads.find((thread) => thread.id === THREAD_ID);
          expect(threadShell?.taskId).toBe(TASK_ID);
          expect(threadShell?.origin).toBe("review-feedback");

          const snapshot = yield* snapshotQuery.getSnapshot();
          expect(snapshot.threads.find((thread) => thread.id === THREAD_ID)?.taskId).toBe(TASK_ID);

          yield* engine.dispatch({
            type: "task.archive",
            commandId: CommandId.make("cmd-archive"),
            taskId: TASK_ID,
          });
          // Archived tasks stay in the shell as history.
          expect(
            Option.getOrThrow(yield* snapshotQuery.getTaskShellById(TASK_ID)).archivedAt,
          ).not.toBeNull();
          expect((yield* snapshotQuery.getShellSnapshot()).tasks?.map((entry) => entry.id)).toEqual(
            [TASK_ID],
          );
          expect(
            Option.getOrThrow(yield* snapshotQuery.getTaskById(TASK_ID)).archivedAt,
          ).not.toBeNull();

          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{ readonly taskId: string | null; readonly origin: string }>`
            SELECT task_id AS "taskId", origin FROM projection_threads WHERE thread_id = ${THREAD_ID}
          `;
          expect(rows).toEqual([{ taskId: TASK_ID, origin: "review-feedback" }]);
        }).pipe(Effect.provide(makeOrchestrationLayer(databasePath)));
      }),
    ),
  );
});
