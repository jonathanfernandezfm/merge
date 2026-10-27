import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { FolderId, ThreadId, WorkTaskId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import ProjectionTasks from "../persistence/Migrations/001_ProjectionTasks.ts";
import * as WorkTaskStore from "../workTasks/WorkTaskStore.ts";
import * as FolderStore from "./FolderStore.ts";

// Every thread exists except "deleted" (getThreadShell is null for deleted and unknown threads).
const projections = Layer.mock(ProjectionStore.ProjectionStoreV2)({
  getThreadShell: (threadId) =>
    Effect.succeed(threadId === "deleted" ? null : ({ id: threadId } as never)),
});

const stores = Layer.mergeAll(
  FolderStore.layer.pipe(Layer.provide(projections)),
  WorkTaskStore.layer,
);

const freshLayer = stores.pipe(
  Layer.provideMerge(
    Layer.effectDiscard(runMigrations()).pipe(
      Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

/** v0.0.10 with old migration 057: folders in projection_folders, links on projection_threads. */
const legacyLayer = stores.pipe(
  Layer.provideMerge(
    Layer.effectDiscard(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 54 });
        yield* ProjectionTasks;
        yield* sql`ALTER TABLE projection_threads ADD COLUMN task_id TEXT`;
        yield* sql`ALTER TABLE projection_threads ADD COLUMN origin TEXT`;
        yield* sql`ALTER TABLE projection_threads ADD COLUMN folder_id TEXT`;
        yield* sql`CREATE TABLE projection_folders (folder_id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)`;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (55, 'ProjectionTasks'), (56, 'TaskScmEvents'), (57, 'ProjectionFolders')`;
        yield* sql`INSERT INTO projection_folders VALUES
          ('folder-1', 'Parked', '2026-10-16T10:00:00.000Z', '2026-10-16T10:00:00.000Z', NULL),
          ('folder-gone', 'Old', '2026-10-15T10:00:00.000Z', '2026-10-16T09:00:00.000Z', '2026-10-16T09:00:00.000Z')`;
        for (const [threadId, folderId, taskId] of [
          ["in-folder", "folder-1", null],
          ["in-both", "folder-1", "task-1"],
          ["in-deleted", "folder-gone", null],
        ] as const) {
          yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at, folder_id, task_id)
            VALUES (${threadId}, 'project', ${threadId}, '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', ${folderId}, ${taskId})`;
        }
        yield* runMigrations();
      }),
    ).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" }))),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const thread = ThreadId.make("thread-a");

describe("FolderStore", () => {
  it.effect("creates, renames and lists folders", () =>
    Effect.gen(function* () {
      const store = yield* FolderStore.FolderStore;
      const id = yield* store.create("Later");
      yield* store.rename(id, "Someday");
      const { folders } = yield* store.snapshot();
      assert.deepStrictEqual(
        folders.map((folder) => [folder.id, folder.title]),
        [[id, "Someday"]],
      );
      const missing = yield* Effect.flip(store.rename(FolderId.make("nope"), "x"));
      assert.strictEqual(missing.reason, "not-found");
    }).pipe(Effect.provide(freshLayer)),
  );

  it.effect("files and unfiles a thread, keeping its Work Task link", () =>
    Effect.gen(function* () {
      const store = yield* FolderStore.FolderStore;
      const tasks = yield* WorkTaskStore.WorkTaskStore;
      const a = yield* store.create("A");
      const b = yield* store.create("B");
      yield* tasks.link(thread, WorkTaskId.make("task-1"), "user");
      yield* store.assign(thread, a);
      yield* store.assign(thread, b);
      assert.deepStrictEqual((yield* store.snapshot()).links, [{ threadId: thread, folderId: b }]);
      yield* store.assign(thread, null);
      assert.deepStrictEqual((yield* store.snapshot()).links, []);
      assert.deepStrictEqual(
        (yield* tasks.links()).map((link) => link.taskId),
        ["task-1"],
      );
      const missing = yield* Effect.flip(store.assign(thread, FolderId.make("nope")));
      assert.strictEqual(missing.reason, "not-found");
      // A deleted (or unknown) thread is never filed, as in v0.0.10.
      const deleted = yield* Effect.flip(store.assign(ThreadId.make("deleted"), a));
      assert.deepStrictEqual([deleted.reason, deleted.message], ["not-found", "Thread not found."]);
      assert.deepStrictEqual((yield* store.snapshot()).links, []);
    }).pipe(Effect.provide(freshLayer)),
  );

  it.effect("deleting a folder moves its threads back and leaves other folders alone", () =>
    Effect.gen(function* () {
      const store = yield* FolderStore.FolderStore;
      const sql = yield* SqlClient.SqlClient;
      const a = yield* store.create("A");
      const b = yield* store.create("B");
      yield* store.assign(thread, a);
      yield* store.assign(ThreadId.make("thread-b"), b);
      yield* store.remove(a);
      const after = yield* store.snapshot();
      assert.deepStrictEqual(
        after.folders.map((folder) => folder.id),
        [b],
      );
      assert.deepStrictEqual(after.links, [{ threadId: ThreadId.make("thread-b"), folderId: b }]);
      const [row] = yield* sql<{ readonly folder_id: string | null }>`
        SELECT folder_id FROM merge_thread_links WHERE thread_id = ${thread}
      `;
      assert.strictEqual(row?.folder_id, null);
      assert.strictEqual((yield* Effect.flip(store.remove(a))).reason, "not-found");
    }).pipe(Effect.provide(freshLayer)),
  );

  it.effect("reads v0.0.10 folders and the links migration 004 carried over", () =>
    Effect.gen(function* () {
      const store = yield* FolderStore.FolderStore;
      const tasks = yield* WorkTaskStore.WorkTaskStore;
      const { folders, links } = yield* store.snapshot();
      assert.deepStrictEqual(
        folders.map((folder) => [folder.id, folder.title]),
        [["folder-1", "Parked"]],
      );
      // The deleted folder's link never surfaces; a thread may sit in a task and a folder.
      assert.deepStrictEqual(
        links.map((link) => [link.threadId, link.folderId]),
        [
          ["in-both", "folder-1"],
          ["in-folder", "folder-1"],
        ],
      );
      assert.deepStrictEqual(
        (yield* tasks.links()).map((link) => link.threadId),
        ["in-both"],
      );
    }).pipe(Effect.provide(legacyLayer)),
  );
});
