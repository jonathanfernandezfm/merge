import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Where a task title came from, so generated names never overwrite one the user typed. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_tasks ADD COLUMN title_source TEXT NOT NULL DEFAULT 'branch'`;
});
