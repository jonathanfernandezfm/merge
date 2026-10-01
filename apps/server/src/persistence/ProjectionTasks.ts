import {
  OrchestrationTask,
  OrchestrationTaskPullRequest,
  OrchestrationTaskWorkspace,
  TaskId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "./Errors.ts";

export const GetProjectionTaskInput = Schema.Struct({
  taskId: TaskId,
});
export type GetProjectionTaskInput = typeof GetProjectionTaskInput.Type;

const ProjectionTaskDbRow = OrchestrationTask.mapFields(
  Struct.assign({
    workspace: Schema.fromJsonString(OrchestrationTaskWorkspace),
    pullRequest: Schema.NullOr(Schema.fromJsonString(OrchestrationTaskPullRequest)),
    autoHandleReviewFeedback: Schema.BooleanFromBit,
    autoHandleCIFailures: Schema.BooleanFromBit,
  }),
);

export class ProjectionTaskRepository extends Context.Service<
  ProjectionTaskRepository,
  {
    readonly upsert: (task: OrchestrationTask) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly getById: (
      input: GetProjectionTaskInput,
    ) => Effect.Effect<Option.Option<OrchestrationTask>, ProjectionRepositoryError>;
    /** Every task, archived ones included, oldest first. */
    readonly listAll: () => Effect.Effect<
      ReadonlyArray<OrchestrationTask>,
      ProjectionRepositoryError
    >;
    /** Tasks that are neither archived nor deleted, oldest first. */
    readonly listActive: () => Effect.Effect<
      ReadonlyArray<OrchestrationTask>,
      ProjectionRepositoryError
    >;
  }
>()("t3/persistence/ProjectionTasks/ProjectionTaskRepository") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: OrchestrationTask,
    execute: (task) => sql`
      INSERT INTO projection_tasks (
        task_id,
        project_id,
        title,
        description,
        workspace_json,
        pull_request_json,
        auto_handle_review_feedback,
        auto_handle_ci_failures,
        waiting_for_user_reason,
        created_at,
        updated_at,
        merged_at,
        archived_at,
        deleted_at
      )
      VALUES (
        ${task.id},
        ${task.projectId},
        ${task.title},
        ${task.description},
        ${JSON.stringify(task.workspace)},
        ${task.pullRequest === null ? null : JSON.stringify(task.pullRequest)},
        ${task.autoHandleReviewFeedback ? 1 : 0},
        ${task.autoHandleCIFailures ? 1 : 0},
        ${task.waitingForUserReason},
        ${task.createdAt},
        ${task.updatedAt},
        ${task.mergedAt},
        ${task.archivedAt},
        ${task.deletedAt}
      )
      ON CONFLICT (task_id)
      DO UPDATE SET
        project_id = excluded.project_id,
        title = excluded.title,
        description = excluded.description,
        workspace_json = excluded.workspace_json,
        pull_request_json = excluded.pull_request_json,
        auto_handle_review_feedback = excluded.auto_handle_review_feedback,
        auto_handle_ci_failures = excluded.auto_handle_ci_failures,
        waiting_for_user_reason = excluded.waiting_for_user_reason,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        merged_at = excluded.merged_at,
        archived_at = excluded.archived_at,
        deleted_at = excluded.deleted_at
    `,
  });

  const getRow = SqlSchema.findOneOption({
    Request: GetProjectionTaskInput,
    Result: ProjectionTaskDbRow,
    execute: ({ taskId }) => sql`
      SELECT
        task_id AS "id",
        project_id AS "projectId",
        title,
        description,
        workspace_json AS "workspace",
        pull_request_json AS "pullRequest",
        auto_handle_review_feedback AS "autoHandleReviewFeedback",
        auto_handle_ci_failures AS "autoHandleCIFailures",
        waiting_for_user_reason AS "waitingForUserReason",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        merged_at AS "mergedAt",
        archived_at AS "archivedAt",
        deleted_at AS "deletedAt"
      FROM projection_tasks
      WHERE task_id = ${taskId}
    `,
  });

  const listAllRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionTaskDbRow,
    execute: () => sql`
      SELECT
        task_id AS "id",
        project_id AS "projectId",
        title,
        description,
        workspace_json AS "workspace",
        pull_request_json AS "pullRequest",
        auto_handle_review_feedback AS "autoHandleReviewFeedback",
        auto_handle_ci_failures AS "autoHandleCIFailures",
        waiting_for_user_reason AS "waitingForUserReason",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        merged_at AS "mergedAt",
        archived_at AS "archivedAt",
        deleted_at AS "deletedAt"
      FROM projection_tasks
      ORDER BY created_at ASC, task_id ASC
    `,
  });

  const listActiveRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionTaskDbRow,
    execute: () => sql`
      SELECT
        task_id AS "id",
        project_id AS "projectId",
        title,
        description,
        workspace_json AS "workspace",
        pull_request_json AS "pullRequest",
        auto_handle_review_feedback AS "autoHandleReviewFeedback",
        auto_handle_ci_failures AS "autoHandleCIFailures",
        waiting_for_user_reason AS "waitingForUserReason",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        merged_at AS "mergedAt",
        archived_at AS "archivedAt",
        deleted_at AS "deletedAt"
      FROM projection_tasks
      WHERE archived_at IS NULL
        AND deleted_at IS NULL
      ORDER BY created_at ASC, task_id ASC
    `,
  });

  const upsert: ProjectionTaskRepository["Service"]["upsert"] = (task) =>
    upsertRow(task).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionTaskRepository.upsert:query")),
    );

  const getById: ProjectionTaskRepository["Service"]["getById"] = (input) =>
    getRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionTaskRepository.getById:query")),
    );

  const listAll: ProjectionTaskRepository["Service"]["listAll"] = () =>
    listAllRows(undefined).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionTaskRepository.listAll:query")),
    );

  const listActive: ProjectionTaskRepository["Service"]["listActive"] = () =>
    listActiveRows(undefined).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionTaskRepository.listActive:query")),
    );

  return {
    upsert,
    getById,
    listAll,
    listActive,
  } satisfies ProjectionTaskRepository["Service"];
});

export const layer = Layer.effect(ProjectionTaskRepository, make);
