import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// v0.0.10 also added projection_threads.task_id/origin here; links now live in merge_thread_links.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
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
});
