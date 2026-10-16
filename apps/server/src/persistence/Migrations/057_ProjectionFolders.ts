import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Folders are environment-wide, so they carry no project id.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_folders (
      folder_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!columns.some((column) => column.name === "folder_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN folder_id TEXT
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_folder
    ON projection_threads(folder_id)
    WHERE folder_id IS NOT NULL
  `;
});
