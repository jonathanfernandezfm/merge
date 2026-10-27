import {
  ThreadId,
  WorkTask,
  WorkTaskId,
  WorkTaskLegacyPullRequest,
  WorkTaskLink,
  WorkTaskOperationError,
  WorkTaskThreadOrigin,
  WorkTaskWorkspace,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

/** `projection_tasks` as v0.0.10 wrote it; `auto_handle_ci_failures` is unused. */
const WorkTaskDbRow = Schema.Struct({
  ...WorkTask.fields,
  workspace: Schema.fromJsonString(WorkTaskWorkspace),
  legacyPullRequest: Schema.NullOr(Schema.fromJsonString(WorkTaskLegacyPullRequest)),
  autoHandleReviewFeedback: Schema.BooleanFromBit,
});

const WorkTaskLinkDbRow = Schema.Struct({
  threadId: ThreadId,
  taskId: WorkTaskId,
  origin: Schema.NullOr(WorkTaskThreadOrigin),
});

export type WorkTaskPatch = Partial<
  Pick<
    WorkTask,
    | "title"
    | "description"
    | "workspace"
    | "autoHandleReviewFeedback"
    | "waitingForUserReason"
    | "mergedAt"
    | "archivedAt"
  >
>;

const failed = (message: string) => (cause: unknown) =>
  new WorkTaskOperationError({ reason: "failed", message, cause });

/**
 * True while a Work Task that is neither archived nor deleted owns the worktree at `path`.
 * Exact path match. Standalone so the `storage-cleanup` seam needs only `SqlClient`.
 */
export const mergeWorkTaskOwnsWorktree = Effect.fn("WorkTaskStore.ownsWorktree")(function* (
  path: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT 1 FROM projection_tasks
    WHERE archived_at IS NULL AND deleted_at IS NULL
      AND json_extract(workspace_json, '$.path') = ${path}
    LIMIT 1
  `;
  return rows.length > 0;
});

export class WorkTaskStore extends Context.Service<
  WorkTaskStore,
  {
    /** Every Work Task that is not deleted, archived ones included, oldest first. */
    readonly list: () => Effect.Effect<ReadonlyArray<WorkTask>, WorkTaskOperationError>;
    readonly get: (id: WorkTaskId) => Effect.Effect<WorkTask | null, WorkTaskOperationError>;
    readonly insert: (task: WorkTask) => Effect.Effect<void, WorkTaskOperationError>;
    /** Stamps `updatedAt`. Fails with `not-found` for an unknown id. */
    readonly update: (
      id: WorkTaskId,
      patch: WorkTaskPatch,
    ) => Effect.Effect<WorkTask, WorkTaskOperationError>;
    /** Thread links that belong to a Work Task. */
    readonly links: () => Effect.Effect<ReadonlyArray<WorkTaskLink>, WorkTaskOperationError>;
    readonly link: (
      threadId: ThreadId,
      taskId: WorkTaskId,
      origin: WorkTaskThreadOrigin,
    ) => Effect.Effect<void, WorkTaskOperationError>;
    /** Detaches the thread from its Work Task; its folder link stays. */
    readonly unlink: (threadId: ThreadId) => Effect.Effect<void, WorkTaskOperationError>;
    readonly ownsWorktree: (path: string) => Effect.Effect<boolean, WorkTaskOperationError>;
    /** Emits once on subscribe, then after writes (coalesced). */
    readonly changes: Stream.Stream<void>;
  }
>()("t3/merge/workTasks/WorkTaskStore") {}

/** @public */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const encodeRow = Schema.encodeEffect(WorkTaskDbRow);
  const changed = yield* PubSub.sliding<void>(1);
  const notify = PubSub.publish(changed, undefined).pipe(Effect.asVoid);

  const selectRows = SqlSchema.findAll({
    Request: Schema.Struct({ id: Schema.optional(WorkTaskId) }),
    Result: WorkTaskDbRow,
    execute: ({ id }) => sql`
      SELECT
        task_id AS "id",
        project_id AS "projectId",
        title,
        description,
        workspace_json AS "workspace",
        pull_request_json AS "legacyPullRequest",
        auto_handle_review_feedback AS "autoHandleReviewFeedback",
        waiting_for_user_reason AS "waitingForUserReason",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        merged_at AS "mergedAt",
        archived_at AS "archivedAt",
        deleted_at AS "deletedAt"
      FROM projection_tasks
      WHERE ${sql.and([
        sql`deleted_at IS NULL`,
        ...(id === undefined ? [] : [sql`task_id = ${id}`]),
      ])}
      ORDER BY created_at ASC, task_id ASC
    `,
  });

  const selectLinks = SqlSchema.findAll({
    Request: Schema.Void,
    Result: WorkTaskLinkDbRow,
    execute: () => sql`
      SELECT thread_id AS "threadId", task_id AS "taskId", origin
      FROM merge_thread_links
      WHERE task_id IS NOT NULL
      ORDER BY thread_id
    `,
  });

  /** `pull_request_json` is written on insert only; it is legacy and never updated. */
  const write = (task: WorkTask, mode: "insert" | "update") =>
    encodeRow(task).pipe(
      Effect.flatMap(
        (row) => sql`
          INSERT INTO projection_tasks (
            task_id, project_id, title, description, workspace_json, pull_request_json,
            auto_handle_review_feedback, waiting_for_user_reason,
            created_at, updated_at, merged_at, archived_at, deleted_at
          )
          VALUES (
            ${row.id}, ${row.projectId}, ${row.title}, ${row.description}, ${row.workspace},
            ${row.legacyPullRequest}, ${row.autoHandleReviewFeedback}, ${row.waitingForUserReason},
            ${row.createdAt}, ${row.updatedAt}, ${row.mergedAt}, ${row.archivedAt}, ${row.deletedAt}
          )
          ${
            mode === "insert"
              ? sql``
              : sql`ON CONFLICT (task_id) DO UPDATE SET
            title = excluded.title,
            description = excluded.description,
            workspace_json = excluded.workspace_json,
            auto_handle_review_feedback = excluded.auto_handle_review_feedback,
            waiting_for_user_reason = excluded.waiting_for_user_reason,
            updated_at = excluded.updated_at,
            merged_at = excluded.merged_at,
            archived_at = excluded.archived_at,
            deleted_at = excluded.deleted_at`
          }
        `,
      ),
    );

  const list = () => selectRows({}).pipe(Effect.mapError(failed("Could not read Work Tasks.")));

  const get = (id: WorkTaskId) =>
    selectRows({ id }).pipe(
      Effect.map((rows) => rows[0] ?? null),
      Effect.mapError(failed("Could not read the Work Task.")),
    );

  const insert = Effect.fn("WorkTaskStore.insert")(function* (task: WorkTask) {
    yield* write(task, "insert").pipe(Effect.mapError(failed("Could not save the Work Task.")));
    yield* notify;
  });

  const update = Effect.fn("WorkTaskStore.update")(function* (
    id: WorkTaskId,
    patch: WorkTaskPatch,
  ) {
    const current = yield* get(id);
    if (current === null) {
      return yield* new WorkTaskOperationError({
        reason: "not-found",
        message: "Work Task not found.",
      });
    }
    const next: WorkTask = {
      ...current,
      ...patch,
      updatedAt: DateTime.formatIso(yield* DateTime.now),
    };
    yield* write(next, "update").pipe(Effect.mapError(failed("Could not save the Work Task.")));
    yield* notify;
    return next;
  });

  const links = () =>
    selectLinks(undefined).pipe(Effect.mapError(failed("Could not read Work Task links.")));

  const link = Effect.fn("WorkTaskStore.link")(function* (
    threadId: ThreadId,
    taskId: WorkTaskId,
    origin: WorkTaskThreadOrigin,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO merge_thread_links (thread_id, task_id, origin, updated_at)
      VALUES (${threadId}, ${taskId}, ${origin}, ${now})
      ON CONFLICT (thread_id) DO UPDATE SET
        task_id = excluded.task_id, origin = excluded.origin, updated_at = excluded.updated_at
    `.pipe(Effect.mapError(failed("Could not link the thread.")));
    yield* notify;
  });

  const unlink = Effect.fn("WorkTaskStore.unlink")(function* (threadId: ThreadId) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      UPDATE merge_thread_links SET task_id = NULL, updated_at = ${now}
      WHERE thread_id = ${threadId}
    `.pipe(Effect.mapError(failed("Could not unlink the thread.")));
    yield* notify;
  });

  const ownsWorktree = (path: string) =>
    mergeWorkTaskOwnsWorktree(path).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.mapError(failed("Could not read Work Task worktrees.")),
    );

  // Subscribe before the first emit so a write between the two is never missed.
  const changes = Stream.unwrap(
    Effect.map(PubSub.subscribe(changed), (subscription) =>
      Stream.concat(Stream.succeed(undefined), Stream.fromSubscription(subscription)),
    ),
  );

  return WorkTaskStore.of({
    list,
    get,
    insert,
    update,
    links,
    link,
    unlink,
    ownsWorktree,
    changes,
  });
});

export const layer = Layer.effect(WorkTaskStore, make);
