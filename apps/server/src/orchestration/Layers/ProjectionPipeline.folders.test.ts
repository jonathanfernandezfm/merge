import { CommandId, FolderId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

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
const PROJECT_ID = ProjectId.make("project-folders");
const THREAD_ID = ThreadId.make("thread-in-folder");
const FOLDER_ID = FolderId.make("folder-1");

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
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-folder-projection-" })),
    Layer.provideMerge(NodeServices.layer),
  );

it.layer(NodeServices.layer)("folder projection", (it) => {
  it.effect("persists folders and filed threads, and releases them on delete", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-folder-projection-",
        });
        const databasePath = path.join(directory, "state.sqlite");

        yield* Effect.gen(function* () {
          const engine = yield* OrchestrationEngineService;
          yield* engine.dispatch({
            type: "project.create",
            commandId: CommandId.make("cmd-project"),
            projectId: PROJECT_ID,
            title: "Folders",
            workspaceRoot: "/tmp/project-folders",
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
            branch: null,
            worktreePath: null,
            createdAt: NOW,
          });
          yield* engine.dispatch({
            type: "folder.create",
            commandId: CommandId.make("cmd-folder"),
            folderId: FOLDER_ID,
            title: "Later",
          });
          yield* engine.dispatch({
            type: "thread.folder.set",
            commandId: CommandId.make("cmd-folder-set"),
            threadId: THREAD_ID,
            folderId: FOLDER_ID,
          });
        }).pipe(Effect.provide(makeOrchestrationLayer(databasePath)));

        // A restart rebuilds the engine read model from projections, so the
        // folder must still exist for the decider.
        yield* Effect.gen(function* () {
          const engine = yield* OrchestrationEngineService;
          const snapshotQuery = yield* ProjectionSnapshotQuery;

          const shell = yield* snapshotQuery.getShellSnapshot();
          expect(shell.folders?.map((folder) => [folder.id, folder.title])).toEqual([
            [FOLDER_ID, "Later"],
          ]);
          expect(shell.threads.find((thread) => thread.id === THREAD_ID)?.folderId).toBe(FOLDER_ID);
          expect(
            Option.getOrThrow(yield* snapshotQuery.getThreadShellById(THREAD_ID)).folderId,
          ).toBe(FOLDER_ID);

          yield* engine.dispatch({
            type: "folder.rename",
            commandId: CommandId.make("cmd-folder-rename"),
            folderId: FOLDER_ID,
            title: "Check back",
          });
          expect(Option.getOrThrow(yield* snapshotQuery.getFolderShellById(FOLDER_ID)).title).toBe(
            "Check back",
          );

          yield* engine.dispatch({
            type: "folder.delete",
            commandId: CommandId.make("cmd-folder-delete"),
            folderId: FOLDER_ID,
          });
          expect(Option.isNone(yield* snapshotQuery.getFolderShellById(FOLDER_ID))).toBe(true);
          const afterDelete = yield* snapshotQuery.getShellSnapshot();
          expect(afterDelete.folders).toEqual([]);
          const thread = afterDelete.threads.find((entry) => entry.id === THREAD_ID);
          expect(thread).toBeDefined();
          expect(thread?.folderId ?? null).toBeNull();
          const readModel = yield* snapshotQuery.getCommandReadModel();
          expect(
            readModel.threads.find((entry) => entry.id === THREAD_ID)?.folderId ?? null,
          ).toBeNull();
        }).pipe(Effect.provide(makeOrchestrationLayer(databasePath)));
      }),
    ),
  );
});
