// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import { migrationManifest, runMigrations } from "../../persistence/Migrations.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { FORK_MIGRATION_TABLE, reconcileForkMigrationHistory } from "./ForkMigrations.ts";
import ProjectionTasks from "./Migrations/001_ProjectionTasks.ts";
import TaskScmEvents from "./Migrations/002_TaskScmEvents.ts";

const REAL_SNAPSHOT = "/tmp/merge-resync/state.sqlite";
const ALL_FORK_MIGRATIONS: Array<readonly [number, string]> = [
  [1, "ProjectionTasks"],
  [2, "TaskScmEvents"],
  [3, "ProjectionFolders"],
  [4, "ThreadLinks"],
  [5, "ThreadLinkReactorMarks"],
];

const memory = NodeSqliteClient.layer({ filename: ":memory:" });

const upstreamHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const forkHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${FORK_MIGRATION_TABLE}
  `;
  if (tables.length === 0) return [];
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM ${sql(FORK_MIGRATION_TABLE)} ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const columnsOf = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly name: string;
    }>`SELECT name FROM pragma_table_info(${table})`;
    return rows.map((row) => row.name);
  });

const insertThread = (
  threadId: string,
  links: { taskId?: string; folderId?: string; origin?: string } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES (${threadId}, 'project', ${threadId}, '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`;
    if (links.taskId) {
      yield* sql`UPDATE projection_threads SET task_id = ${links.taskId} WHERE thread_id = ${threadId}`;
    }
    if (links.folderId) {
      yield* sql`UPDATE projection_threads SET folder_id = ${links.folderId} WHERE thread_id = ${threadId}`;
    }
    if (links.origin) {
      yield* sql`UPDATE projection_threads SET origin = ${links.origin} WHERE thread_id = ${threadId}`;
    }
  });

/** The shape v0.0.10 left behind: upstream 1..54 plus fork rows 55/56 (and 57 when folders ran). */
const seedLegacyFork = (options: { withFolders?: boolean } = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 54 });
    yield* ProjectionTasks;
    yield* sql`ALTER TABLE projection_threads ADD COLUMN task_id TEXT`;
    yield* sql`ALTER TABLE projection_threads ADD COLUMN origin TEXT`;
    yield* TaskScmEvents;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (55, 'ProjectionTasks'), (56, 'TaskScmEvents')`;
    if (options.withFolders) {
      yield* sql`CREATE TABLE projection_folders (folder_id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)`;
      yield* sql`ALTER TABLE projection_threads ADD COLUMN folder_id TEXT`;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (57, 'ProjectionFolders')`;
    }
    yield* sql`INSERT INTO projection_tasks (task_id, project_id, title, workspace_json, created_at, updated_at)
      VALUES ('task-1', 'project', 'Task', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
  });

const upstreamThrough54 = migrationManifest.filter(([id]) => id <= 54);

describe("reconcileForkMigrationHistory", () => {
  it.effect("moves legacy fork rows out of effect_sql_migrations", () =>
    Effect.gen(function* () {
      yield* seedLegacyFork();
      yield* reconcileForkMigrationHistory();

      assert.deepStrictEqual(yield* upstreamHistory, upstreamThrough54);
      assert.deepStrictEqual(yield* forkHistory, [
        [1, "ProjectionTasks"],
        [2, "TaskScmEvents"],
      ]);
    }).pipe(Effect.provide(memory)),
  );

  it.effect("ignores upstream 55 OrchestrationV2", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      // Same ids as the fork's legacy rows but upstream names: only id AND name may move.
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (55, 'OrchestrationV2'), (57, 'ScheduledTaskWebhooks')`;
      const before = yield* upstreamHistory;

      yield* reconcileForkMigrationHistory();

      assert.deepStrictEqual(yield* upstreamHistory, before);
      assert.deepStrictEqual(yield* forkHistory, []);
    }).pipe(Effect.provide(memory)),
  );

  it.effect("is idempotent", () =>
    Effect.gen(function* () {
      yield* seedLegacyFork({ withFolders: true });
      yield* reconcileForkMigrationHistory();
      const upstream = yield* upstreamHistory;
      const fork = yield* forkHistory;
      yield* reconcileForkMigrationHistory();

      assert.deepStrictEqual(yield* upstreamHistory, upstream);
      assert.deepStrictEqual(yield* forkHistory, fork);
      assert.deepStrictEqual(fork, ALL_FORK_MIGRATIONS.slice(0, 3));
    }).pipe(Effect.provide(memory)),
  );
});

describe("runMigrations with fork migrations", () => {
  it.effect("full runMigrations on a fork-shaped DB", () => {
    const warnings: string[] = [];
    const logger = Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push(String(message));
    });
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedLegacyFork();

      yield* runMigrations();
      assert.deepStrictEqual(yield* upstreamHistory, migrationManifest);
      assert.deepStrictEqual(yield* forkHistory, ALL_FORK_MIGRATIONS);

      // Second start: upstream 55..latest and fork 1..4 are both recorded.
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* upstreamHistory, migrationManifest);
      assert.deepStrictEqual(yield* forkHistory, ALL_FORK_MIGRATIONS);

      const tasks = yield* sql<{ readonly task_id: string }>`SELECT task_id FROM projection_tasks`;
      assert.deepStrictEqual(
        tasks.map((row) => row.task_id),
        ["task-1"],
      );
      assert.deepStrictEqual(warnings, []);
    }).pipe(
      Effect.provide(Layer.mergeAll(memory, Logger.layer([logger], { mergeWithExisting: false }))),
    );
  });

  it.effect(
    "004 copies projection_threads.task_id/folder_id into merge_thread_links when the columns exist",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedLegacyFork({ withFolders: true });
        yield* insertThread("in-task", { taskId: "task-1", origin: "review-feedback" });
        yield* insertThread("in-folder", { folderId: "folder-1" });
        yield* insertThread("in-both", { taskId: "task-1", folderId: "folder-1", origin: "user" });
        yield* insertThread("unlinked");

        yield* runMigrations();

        const links = yield* sql<{
          readonly thread_id: string;
          readonly task_id: string | null;
          readonly folder_id: string | null;
          readonly origin: string | null;
          readonly updated_at: string;
        }>`SELECT thread_id, task_id, folder_id, origin, updated_at FROM merge_thread_links ORDER BY thread_id`;
        assert.deepStrictEqual(
          links.map((row) => ({ ...row })),
          [
            {
              thread_id: "in-both",
              task_id: "task-1",
              folder_id: "folder-1",
              origin: "user",
              updated_at: "2026-01-02T00:00:00.000Z",
            },
            {
              thread_id: "in-folder",
              task_id: null,
              folder_id: "folder-1",
              origin: null,
              updated_at: "2026-01-02T00:00:00.000Z",
            },
            {
              thread_id: "in-task",
              task_id: "task-1",
              folder_id: null,
              origin: "review-feedback",
              updated_at: "2026-01-02T00:00:00.000Z",
            },
          ],
        );
      }).pipe(Effect.provide(memory)),
  );

  it.effect("fresh DB", () =>
    Effect.gen(function* () {
      yield* runMigrations();

      assert.deepStrictEqual(yield* upstreamHistory, migrationManifest);
      assert.deepStrictEqual(yield* forkHistory, ALL_FORK_MIGRATIONS);
      for (const table of [
        "projection_tasks",
        "task_scm_events",
        "projection_folders",
        "merge_thread_links",
      ]) {
        assert.isNotEmpty(yield* columnsOf(table), table);
      }
      assert.notInclude(yield* columnsOf("projection_threads"), "task_id");
      assert.notInclude(yield* columnsOf("projection_threads"), "folder_id");
    }).pipe(Effect.provide(memory)),
  );

  it.effect.skipIf(!NodeFS.existsSync(REAL_SNAPSHOT))(
    "starts the real v0.0.10 snapshot through initializeV2Database",
    () => {
      const directory = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "merge-fork-migrations-"),
      );
      const sourcePath = NodePath.join(directory, "state.sqlite");
      NodeFS.copyFileSync(REAL_SNAPSHOT, sourcePath);
      const original = NodeFS.readFileSync(sourcePath);
      return Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const layerDatabase = SqlitePersistence.layerConfig.pipe(
          Layer.provide(
            ServerConfig.layer({
              ...config,
              dbPath: NodePath.join(directory, "statev2.sqlite"),
            }),
          ),
        );
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const count = (table: string) =>
            sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM ${sql(table)}`.pipe(
              Effect.map((rows) => rows[0]?.count),
            );
          assert.strictEqual(yield* count("projection_tasks"), 22);
          assert.strictEqual(yield* count("projection_threads"), 171);
          assert.deepStrictEqual(yield* upstreamHistory, migrationManifest);
          assert.deepStrictEqual(yield* forkHistory, ALL_FORK_MIGRATIONS);
          const linked = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM projection_threads WHERE task_id IS NOT NULL
          `;
          assert.strictEqual(yield* count("merge_thread_links"), linked[0]?.count);
          const origins = yield* sql<{ readonly origin: string; readonly count: number }>`
            SELECT origin, COUNT(*) AS count FROM merge_thread_links
            WHERE origin IS NOT NULL GROUP BY origin ORDER BY origin
          `;
          assert.deepStrictEqual(
            origins.map((row) => [row.origin, row.count]),
            [
              ["review-feedback", 26],
              ["user", 99],
            ],
          );
        }).pipe(Effect.provide(layerDatabase));
        assert.isTrue(NodeFS.readFileSync(sourcePath).equals(original), "state.sqlite changed");
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(directory, directory).pipe(Layer.provideMerge(NodeServices.layer)),
        ),
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
        ),
      );
    },
  );
});
