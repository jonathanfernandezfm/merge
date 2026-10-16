import {
  CommandId,
  FolderId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const FOLDER_ID = FolderId.make("folder-1");

// Decide a command and fold its events into the read model, like the engine.
const dispatch = Effect.fn("dispatch")(function* (
  readModel: OrchestrationReadModel,
  command: OrchestrationCommand,
) {
  const decided = yield* decideOrchestrationCommand({ command, readModel });
  const events = Array.isArray(decided) ? decided : [decided];
  let next = readModel;
  for (const event of events) {
    next = yield* projectEvent(next, { ...event, sequence: next.snapshotSequence + 1 });
  }
  return { readModel: next, events };
});

const setFolder = (readModel: OrchestrationReadModel, folderId: FolderId | null) =>
  dispatch(readModel, {
    type: "thread.folder.set",
    commandId: CommandId.make("cmd-folder-set"),
    threadId: THREAD_ID,
    folderId,
  });

const deleteFolder = (readModel: OrchestrationReadModel) =>
  dispatch(readModel, {
    type: "folder.delete",
    commandId: CommandId.make("cmd-folder-delete"),
    folderId: FOLDER_ID,
  });

const withThreadAndFolder = Effect.gen(function* () {
  let readModel = createEmptyReadModel(NOW);
  readModel = (yield* dispatch(readModel, {
    type: "project.create",
    commandId: CommandId.make("cmd-project"),
    projectId: PROJECT_ID,
    title: "Project",
    workspaceRoot: "/repo",
    createdAt: NOW,
  })).readModel;
  readModel = (yield* dispatch(readModel, {
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
  })).readModel;
  return (yield* dispatch(readModel, {
    type: "folder.create",
    commandId: CommandId.make("cmd-folder"),
    folderId: FOLDER_ID,
    title: "Later",
  })).readModel;
});

it.layer(NodeServices.layer)("folder decider", (it) => {
  it.effect("folder.create projects a live folder and rejects a duplicate id", () =>
    Effect.gen(function* () {
      const readModel = yield* withThreadAndFolder;
      expect(
        readModel.folders?.map((folder) => [folder.id, folder.title, folder.deletedAt]),
      ).toEqual([[FOLDER_ID, "Later", null]]);

      const duplicate = yield* Effect.exit(
        dispatch(readModel, {
          type: "folder.create",
          commandId: CommandId.make("cmd-folder-2"),
          folderId: FOLDER_ID,
          title: "Again",
        }),
      );
      expect(Exit.isFailure(duplicate)).toBe(true);
    }),
  );

  it.effect("thread.folder.set files a thread without touching its updatedAt", () =>
    Effect.gen(function* () {
      const before = yield* withThreadAndFolder;
      const { readModel, events } = yield* setFolder(before, FOLDER_ID);
      expect(events.map((event) => [event.type, event.aggregateKind])).toEqual([
        ["thread.folder-set", "thread"],
      ]);
      const thread = readModel.threads.find((entry) => entry.id === THREAD_ID);
      expect(thread?.folderId).toBe(FOLDER_ID);
      expect(thread?.updatedAt).toBe(before.threads[0]?.updatedAt);

      const removed = yield* setFolder(readModel, null);
      expect(removed.readModel.threads[0]?.folderId).toBeNull();
    }),
  );

  it.effect("thread.folder.set rejects a missing or deleted folder", () =>
    Effect.gen(function* () {
      const readModel = yield* withThreadAndFolder;
      const missing = yield* Effect.exit(setFolder(readModel, FolderId.make("folder-missing")));
      expect(Exit.isFailure(missing)).toBe(true);

      const deleted = yield* deleteFolder(readModel);
      const intoDeleted = yield* Effect.exit(setFolder(deleted.readModel, FOLDER_ID));
      expect(Exit.isFailure(intoDeleted)).toBe(true);
    }),
  );

  it.effect("folder.delete releases its threads instead of deleting them", () =>
    Effect.gen(function* () {
      const filed = (yield* setFolder(yield* withThreadAndFolder, FOLDER_ID)).readModel;
      const { readModel, events } = yield* deleteFolder(filed);
      expect(events.map((event) => event.type)).toEqual(["folder.deleted"]);
      expect(readModel.folders?.[0]?.deletedAt).not.toBeNull();
      const thread = readModel.threads.find((entry) => entry.id === THREAD_ID);
      expect(thread?.folderId).toBeNull();
      expect(thread?.deletedAt).toBeNull();
      expect(thread?.archivedAt).toBeNull();
    }),
  );

  it.effect("folder.rename renames a live folder and rejects a deleted one", () =>
    Effect.gen(function* () {
      const rename = (readModel: OrchestrationReadModel) =>
        dispatch(readModel, {
          type: "folder.rename",
          commandId: CommandId.make("cmd-folder-rename"),
          folderId: FOLDER_ID,
          title: "Check back",
        });
      const live = yield* withThreadAndFolder;
      expect((yield* rename(live)).readModel.folders?.[0]?.title).toBe("Check back");

      const deleted = (yield* deleteFolder(live)).readModel;
      expect(Exit.isFailure(yield* Effect.exit(rename(deleted)))).toBe(true);
    }),
  );
});
