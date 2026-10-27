import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Folders are environment-wide, so they carry no project id.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_folders (
      folder_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;
});
