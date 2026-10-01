import { TaskId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "./Errors.ts";

/**
 * `pending` waits for the supervisor, `handling` is claimed by one dispatch
 * (`handled_at` holds the claim time until it settles, `handling_thread_id`
 * the thread it is about to create), `handled` names the thread that took it,
 * `ignored` needs no action (a baseline comment or an informational event) and
 * `failed` gave up.
 */
export const TaskScmEventState = Schema.Literals([
  "pending",
  "handling",
  "handled",
  "ignored",
  "failed",
]);
export type TaskScmEventState = typeof TaskScmEventState.Type;

export const TaskScmEventRow = Schema.Struct({
  id: Schema.String,
  taskId: TaskId,
  providerEventKey: Schema.String,
  type: Schema.String,
  payloadJson: Schema.String,
  observedAt: Schema.String,
  handledAt: Schema.NullOr(Schema.String),
  handlingThreadId: Schema.NullOr(ThreadId),
  state: TaskScmEventState,
});
export type TaskScmEventRow = typeof TaskScmEventRow.Type;

const TaskScmEventInsert = Schema.Struct({
  id: Schema.String,
  taskId: TaskId,
  providerEventKey: Schema.String,
  type: Schema.String,
  payloadJson: Schema.String,
  observedAt: Schema.String,
  state: TaskScmEventState,
});
export type TaskScmEventInsert = typeof TaskScmEventInsert.Type;

const TaskTypeInput = Schema.Struct({ taskId: TaskId, type: Schema.String });

const SELECT_COLUMNS = `
  id,
  task_id AS "taskId",
  provider_event_key AS "providerEventKey",
  type,
  payload_json AS "payloadJson",
  observed_at AS "observedAt",
  handled_at AS "handledAt",
  handling_thread_id AS "handlingThreadId",
  state
`;

/**
 * The task supervisor's event ledger. Not a Context service: like the task
 * projection reads, the supervisor builds it from the SQL client it already has.
 */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = sql.literal(SELECT_COLUMNS);

  const insertRow = SqlSchema.void({
    Request: TaskScmEventInsert,
    execute: (row) => sql`
      INSERT INTO task_scm_events (
        id, task_id, provider_event_key, type, payload_json, observed_at, state
      )
      VALUES (
        ${row.id}, ${row.taskId}, ${row.providerEventKey}, ${row.type},
        ${row.payloadJson}, ${row.observedAt}, ${row.state}
      )
      ON CONFLICT (task_id, provider_event_key) DO NOTHING
    `,
  });

  const listByTaskRows = SqlSchema.findAll({
    Request: TaskId,
    Result: TaskScmEventRow,
    execute: (taskId) => sql`
      SELECT ${columns} FROM task_scm_events
      WHERE task_id = ${taskId}
      ORDER BY rowid ASC
    `,
  });

  const countPendingRows = SqlSchema.findAll({
    Request: TaskTypeInput,
    Result: Schema.Struct({ count: Schema.Number }),
    execute: ({ taskId, type }) => sql`
      SELECT COUNT(*) AS "count" FROM task_scm_events
      WHERE task_id = ${taskId} AND type = ${type} AND state = 'pending'
    `,
  });

  // One statement, so two evaluations racing for the same task cannot both
  // claim an event: the loser's UPDATE matches no rows. The claim records the
  // id of the thread the dispatch is about to create, so a crash right after
  // creating it is recoverable.
  const claimPendingRows = SqlSchema.findAll({
    Request: Schema.Struct({
      ...TaskTypeInput.fields,
      claimedAt: Schema.String,
      handlingThreadId: ThreadId,
    }),
    Result: TaskScmEventRow,
    execute: ({ taskId, type, claimedAt, handlingThreadId }) => sql`
      UPDATE task_scm_events
      SET state = 'handling', handled_at = ${claimedAt}, handling_thread_id = ${handlingThreadId}
      WHERE task_id = ${taskId} AND type = ${type} AND state = 'pending'
      RETURNING ${columns}
    `,
  });

  // A claim is settled in the same dispatch that made it, so a row left in
  // `handling` means that dispatch died. If the thread it named reached the
  // read model, the row is done; otherwise nothing took it and it is offered
  // again.
  const recoverHandledRows = SqlSchema.void({
    Request: Schema.Struct({ claimedBefore: Schema.NullOr(Schema.String) }),
    execute: ({ claimedBefore }) => sql`
      UPDATE task_scm_events SET state = 'handled'
      WHERE state = 'handling' AND handling_thread_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM projection_threads
          WHERE projection_threads.thread_id = task_scm_events.handling_thread_id
        )
        AND (${claimedBefore} IS NULL OR handled_at IS NULL OR handled_at < ${claimedBefore})
    `,
  });

  // Runs after the handled pass, so every claim still in `handling` here has
  // no thread behind it.
  const recoverPendingRows = SqlSchema.void({
    Request: Schema.Struct({ claimedBefore: Schema.NullOr(Schema.String) }),
    execute: ({ claimedBefore }) => sql`
      UPDATE task_scm_events SET state = 'pending', handled_at = NULL, handling_thread_id = NULL
      WHERE state = 'handling'
        AND (${claimedBefore} IS NULL OR handled_at IS NULL OR handled_at < ${claimedBefore})
    `,
  });

  const settleRows = SqlSchema.void({
    Request: Schema.Struct({
      ids: Schema.Array(Schema.String),
      state: TaskScmEventState,
      handledAt: Schema.String,
      handlingThreadId: Schema.NullOr(ThreadId),
    }),
    execute: ({ ids, state, handledAt, handlingThreadId }) => sql`
      UPDATE task_scm_events
      SET state = ${state}, handled_at = ${handledAt}, handling_thread_id = ${handlingThreadId}
      WHERE ${sql.in("id", ids)} AND state = 'handling'
    `,
  });

  return {
    /** Record events; a key already in the ledger keeps its row untouched. */
    insertIgnore: (rows: ReadonlyArray<TaskScmEventInsert>) =>
      Effect.forEach(rows, (row) => insertRow(row), { discard: true }).pipe(
        sql.withTransaction,
        Effect.mapError(toPersistenceSqlError("TaskScmEvents.insertIgnore:query")),
      ),
    listByTask: (taskId: TaskId) =>
      listByTaskRows(taskId).pipe(
        Effect.mapError(toPersistenceSqlError("TaskScmEvents.listByTask:query")),
      ),
    hasPending: (taskId: TaskId, type: string) =>
      countPendingRows({ taskId, type }).pipe(
        Effect.map((rows) => (rows[0]?.count ?? 0) > 0),
        Effect.mapError(toPersistenceSqlError("TaskScmEvents.hasPending:query")),
      ),
    /**
     * Move every pending event of `type` to `handling` for the thread
     * `handlingThreadId` that will take them, and return them in no set order.
     */
    claimPending: (taskId: TaskId, type: string, claimedAt: string, handlingThreadId: ThreadId) =>
      claimPendingRows({ taskId, type, claimedAt, handlingThreadId }).pipe(
        Effect.mapError(toPersistenceSqlError("TaskScmEvents.claimPending:query")),
      ),
    /**
     * Release claims a dispatch never settled: every one when `claimedBefore` is
     * null (nothing can be mid-dispatch at startup), else those claimed earlier.
     */
    recoverStuck: (input: { readonly claimedBefore: string | null }) =>
      // Sequential: the pending pass relies on the handled pass running first.
      Effect.all([recoverHandledRows(input), recoverPendingRows(input)], {
        discard: true,
        concurrency: 1,
      }).pipe(
        sql.withTransaction,
        Effect.mapError(toPersistenceSqlError("TaskScmEvents.recoverStuck:query")),
      ),
    /** Finish claimed events as `handled` (with their thread) or `failed`. */
    settle: (input: {
      readonly ids: ReadonlyArray<string>;
      readonly state: "handled" | "failed";
      readonly handledAt: string;
      readonly handlingThreadId: ThreadId | null;
    }) =>
      input.ids.length === 0
        ? Effect.void
        : settleRows(input).pipe(
            Effect.mapError(toPersistenceSqlError("TaskScmEvents.settle:query")),
          ),
  };
});

export type TaskScmEventLedger = Effect.Success<typeof make>;
