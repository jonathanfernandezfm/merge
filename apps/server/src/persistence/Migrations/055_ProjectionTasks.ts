import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The workspace and pull request are small nested documents read whole
  // with the task, so they live in JSON columns.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_tasks (
      task_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      workspace_json TEXT NOT NULL,
      pull_request_json TEXT,
      auto_handle_review_feedback INTEGER NOT NULL DEFAULT 0,
      auto_handle_ci_failures INTEGER NOT NULL DEFAULT 0,
      waiting_for_user_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      merged_at TEXT,
      archived_at TEXT,
      deleted_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_tasks_project
    ON projection_tasks(project_id, archived_at)
  `;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!columns.some((column) => column.name === "task_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN task_id TEXT
    `;
  }
  if (!columns.some((column) => column.name === "origin")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN origin TEXT
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_task
    ON projection_threads(task_id)
    WHERE task_id IS NOT NULL
  `;
});
