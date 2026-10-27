import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** What the Work Task reactor did to a linked thread, so it never undoes a user's choice. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The PR key the reactor linked on this thread; a user unlink of that key sticks.
  yield* sql`ALTER TABLE merge_thread_links ADD COLUMN auto_linked_pr_key TEXT`;
  // Review thread watch: 'on' (reactor watched it), 'held' (reactor paused it), NULL (not yet).
  yield* sql`ALTER TABLE merge_thread_links ADD COLUMN review_watch TEXT`;
});
