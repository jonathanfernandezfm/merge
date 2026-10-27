import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import ProjectionTasks from "./Migrations/001_ProjectionTasks.ts";
import TaskScmEvents from "./Migrations/002_TaskScmEvents.ts";
import ProjectionFolders from "./Migrations/003_ProjectionFolders.ts";
import ThreadLinks from "./Migrations/004_ThreadLinks.ts";

/** Fork history lives apart so upstream's `effect_sql_migrations` ids never collide with ours. */
export const FORK_MIGRATION_TABLE = "merge_fork_migrations";

// Rows v0.0.10 recorded in effect_sql_migrations: [legacy id, name, fork id].
const LEGACY_FORK_ROWS = [
  [55, "ProjectionTasks", 1],
  [56, "TaskScmEvents", 2],
  [57, "ProjectionFolders", 3],
] as const;

export const reconcileForkMigrationHistory = Effect.fn("reconcileForkMigrationHistory")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const tables = yield* sql`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
        `;
        if (tables.length === 0) return;
        // Same DDL as Effect's Migrator so it adopts the table as its own.
        yield* sql`
          CREATE TABLE IF NOT EXISTS ${sql(FORK_MIGRATION_TABLE)} (
            migration_id integer PRIMARY KEY NOT NULL,
            created_at datetime NOT NULL DEFAULT current_timestamp,
            name VARCHAR(255) NOT NULL
          )
        `;
        for (const [legacyId, name, forkId] of LEGACY_FORK_ROWS) {
          yield* sql`
            INSERT OR IGNORE INTO ${sql(FORK_MIGRATION_TABLE)} (migration_id, created_at, name)
            SELECT ${forkId}, created_at, name FROM effect_sql_migrations
            WHERE migration_id = ${legacyId} AND name = ${name}
          `;
          yield* sql`
            DELETE FROM effect_sql_migrations WHERE migration_id = ${legacyId} AND name = ${name}
          `;
        }
      }),
    );
  },
);

const runFork = Migrator.make({});

export const runForkMigrations = Effect.fn("runForkMigrations")(function* () {
  const executed = yield* runFork({
    table: FORK_MIGRATION_TABLE,
    loader: Migrator.fromRecord({
      "1_ProjectionTasks": ProjectionTasks,
      "2_TaskScmEvents": TaskScmEvents,
      "3_ProjectionFolders": ProjectionFolders,
      "4_ThreadLinks": ThreadLinks,
    }),
  });
  if (executed.length > 0) {
    yield* Effect.log("Fork migrations ran successfully").pipe(
      Effect.annotateLogs({ migrations: executed.map(([id, name]) => `${id}_${name}`) }),
    );
  }
  return executed;
});
