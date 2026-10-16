import { FolderId, OrchestrationFolder } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "./Errors.ts";

export const GetProjectionFolderInput = Schema.Struct({
  folderId: FolderId,
});
export type GetProjectionFolderInput = typeof GetProjectionFolderInput.Type;

export class ProjectionFolderRepository extends Context.Service<
  ProjectionFolderRepository,
  {
    readonly upsert: (
      folder: OrchestrationFolder,
    ) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly getById: (
      input: GetProjectionFolderInput,
    ) => Effect.Effect<Option.Option<OrchestrationFolder>, ProjectionRepositoryError>;
    /** Every folder, deleted ones included, oldest first. */
    readonly listAll: () => Effect.Effect<
      ReadonlyArray<OrchestrationFolder>,
      ProjectionRepositoryError
    >;
    /** Clears `folder_id` on every thread filed in the folder. */
    readonly releaseThreads: (
      input: GetProjectionFolderInput,
    ) => Effect.Effect<void, ProjectionRepositoryError>;
  }
>()("merge-agent/persistence/ProjectionFolders/ProjectionFolderRepository") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: OrchestrationFolder,
    execute: (folder) => sql`
      INSERT INTO projection_folders (folder_id, title, created_at, updated_at, deleted_at)
      VALUES (
        ${folder.id},
        ${folder.title},
        ${folder.createdAt},
        ${folder.updatedAt},
        ${folder.deletedAt}
      )
      ON CONFLICT (folder_id)
      DO UPDATE SET
        title = excluded.title,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at
    `,
  });

  const getRow = SqlSchema.findOneOption({
    Request: GetProjectionFolderInput,
    Result: OrchestrationFolder,
    execute: ({ folderId }) => sql`
      SELECT
        folder_id AS "id",
        title,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        deleted_at AS "deletedAt"
      FROM projection_folders
      WHERE folder_id = ${folderId}
    `,
  });

  const listAllRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: OrchestrationFolder,
    execute: () => sql`
      SELECT
        folder_id AS "id",
        title,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        deleted_at AS "deletedAt"
      FROM projection_folders
      ORDER BY created_at ASC, folder_id ASC
    `,
  });

  const releaseThreadRows = SqlSchema.void({
    Request: GetProjectionFolderInput,
    execute: ({ folderId }) => sql`
      UPDATE projection_threads
      SET folder_id = NULL
      WHERE folder_id = ${folderId}
    `,
  });

  const upsert: ProjectionFolderRepository["Service"]["upsert"] = (folder) =>
    upsertRow(folder).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionFolderRepository.upsert:query")),
    );

  const getById: ProjectionFolderRepository["Service"]["getById"] = (input) =>
    getRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionFolderRepository.getById:query")),
    );

  const listAll: ProjectionFolderRepository["Service"]["listAll"] = () =>
    listAllRows(undefined).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionFolderRepository.listAll:query")),
    );

  const releaseThreads: ProjectionFolderRepository["Service"]["releaseThreads"] = (input) =>
    releaseThreadRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionFolderRepository.releaseThreads:query")),
    );

  return {
    upsert,
    getById,
    listAll,
    releaseThreads,
  } satisfies ProjectionFolderRepository["Service"];
});

export const layer = Layer.effect(ProjectionFolderRepository, make);
