import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import migrateProjectionTasks from "./055_ProjectionTasks.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("055_ProjectionTasks", (it) => {
  it.effect("adds the task table and leaves existing threads outside any task", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      const now = "2026-01-01T00:00:00.000Z";
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          created_at, updated_at
        ) VALUES (
          'thread-1', 'project-1', 'Existing thread',
          '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', ${now}, ${now}
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 55 });
      const threads = yield* sql<{
        readonly taskId: string | null;
        readonly origin: string | null;
      }>`
        SELECT task_id AS "taskId", origin FROM projection_threads WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(threads, [{ taskId: null, origin: null }]);
      assert.deepEqual(yield* sql`SELECT * FROM projection_tasks`, []);

      // Re-running against a migrated database keeps existing values.
      yield* sql`UPDATE projection_threads SET task_id = 'task-1' WHERE thread_id = 'thread-1'`;
      yield* migrateProjectionTasks;
      const rerun = yield* sql<{ readonly taskId: string | null }>`
        SELECT task_id AS "taskId" FROM projection_threads WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(rerun, [{ taskId: "task-1" }]);
    }),
  );
});
