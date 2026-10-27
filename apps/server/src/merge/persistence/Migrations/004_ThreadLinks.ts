import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS merge_thread_links (
      thread_id TEXT PRIMARY KEY,
      task_id TEXT,
      folder_id TEXT,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_merge_thread_links_task ON merge_thread_links(task_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_merge_thread_links_folder ON merge_thread_links(folder_id)`;

  // v0.0.10 stored links as projection_threads columns; either may be missing.
  const columns = new Set(
    (yield* sql<{
      readonly name: string;
    }>`SELECT name FROM pragma_table_info('projection_threads')`).map((column) => column.name),
  );
  const taskId = columns.has("task_id") ? "task_id" : "NULL";
  const folderId = columns.has("folder_id") ? "folder_id" : "NULL";
  if (taskId === "NULL" && folderId === "NULL") return;
  yield* sql.unsafe(`
    INSERT OR IGNORE INTO merge_thread_links (thread_id, task_id, folder_id, updated_at)
    SELECT thread_id, ${taskId}, ${folderId}, updated_at FROM projection_threads
    WHERE ${taskId} IS NOT NULL OR ${folderId} IS NOT NULL
  `);
});
