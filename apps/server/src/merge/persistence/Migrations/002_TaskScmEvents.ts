import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // provider_event_key is deterministic per host event, so re-observing one is an ignored insert.
  yield* sql`
    CREATE TABLE IF NOT EXISTS task_scm_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      provider_event_key TEXT NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      handled_at TEXT,
      handling_thread_id TEXT,
      state TEXT NOT NULL,
      UNIQUE (task_id, provider_event_key)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_task_scm_events_task_state
    ON task_scm_events(task_id, state, type)
  `;
});
