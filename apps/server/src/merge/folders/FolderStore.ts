import {
  Folder,
  FolderId,
  FolderLink,
  FolderOperationError,
  type FoldersSnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

const failed = (message: string) => (cause: unknown) =>
  new FolderOperationError({ reason: "failed", message, cause });

const notFound = new FolderOperationError({ reason: "not-found", message: "Folder not found." });

export class FolderStore extends Context.Service<
  FolderStore,
  {
    /** Live folders and the threads filed in them, oldest folder first. */
    readonly snapshot: () => Effect.Effect<FoldersSnapshot, FolderOperationError>;
    readonly create: (title: string) => Effect.Effect<FolderId, FolderOperationError>;
    readonly rename: (id: FolderId, title: string) => Effect.Effect<void, FolderOperationError>;
    /** Soft-deletes the folder; its threads move back to the thread list. */
    readonly remove: (id: FolderId) => Effect.Effect<void, FolderOperationError>;
    /** Files the thread in a live folder, or takes it out with null. Its Work Task link stays. */
    readonly assign: (
      threadId: ThreadId,
      folderId: FolderId | null,
    ) => Effect.Effect<void, FolderOperationError>;
    /** Emits once on subscribe, then after writes (coalesced). */
    readonly changes: Stream.Stream<void>;
  }
>()("t3/merge/folders/FolderStore") {}

/** @public */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const changed = yield* PubSub.sliding<void>(1);
  const notify = PubSub.publish(changed, undefined).pipe(Effect.asVoid);
  const now = Effect.map(DateTime.now, DateTime.formatIso);

  // One bad row is logged and skipped, so it never hides the others.
  const decodeEach =
    <S extends Schema.Decoder<unknown>>(schema: S, what: string) =>
    (rows: ReadonlyArray<unknown>) => {
      const decode = Schema.decodeUnknownEffect(schema);
      return Effect.forEach(rows, (row) =>
        decode(row).pipe(
          Effect.map((value) => [value]),
          Effect.catch((cause) =>
            Effect.logWarning(`Skipping an unreadable ${what} row.`, cause).pipe(Effect.as([])),
          ),
        ),
      ).pipe(Effect.map((decoded) => decoded.flat()));
    };

  const snapshot = () =>
    Effect.all({
      folders: sql`
        SELECT folder_id AS "id", title, created_at AS "createdAt", updated_at AS "updatedAt"
        FROM projection_folders WHERE deleted_at IS NULL
        ORDER BY created_at ASC, folder_id ASC
      `.pipe(Effect.flatMap(decodeEach(Folder, "projection_folders"))),
      // Only links to live folders, so a stale id never hides a thread.
      links: sql`
        SELECT l.thread_id AS "threadId", l.folder_id AS "folderId"
        FROM merge_thread_links l
        JOIN projection_folders f ON f.folder_id = l.folder_id AND f.deleted_at IS NULL
        ORDER BY l.thread_id
      `.pipe(Effect.flatMap(decodeEach(FolderLink, "merge_thread_links"))),
    }).pipe(Effect.mapError(failed("Could not read folders.")));

  const requireLive = (id: FolderId) =>
    sql`SELECT 1 FROM projection_folders WHERE folder_id = ${id} AND deleted_at IS NULL`.pipe(
      Effect.mapError(failed("Could not read the folder.")),
      Effect.flatMap((rows) => (rows.length === 0 ? Effect.fail(notFound) : Effect.void)),
    );

  const create = Effect.fn("FolderStore.create")(function* (title: string) {
    const id = FolderId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie));
    const at = yield* now;
    yield* sql`
      INSERT INTO projection_folders (folder_id, title, created_at, updated_at, deleted_at)
      VALUES (${id}, ${title}, ${at}, ${at}, NULL)
    `.pipe(Effect.mapError(failed("Could not create the folder.")));
    yield* notify;
    return id;
  });

  const rename = Effect.fn("FolderStore.rename")(function* (id: FolderId, title: string) {
    yield* requireLive(id);
    yield* sql`
      UPDATE projection_folders SET title = ${title}, updated_at = ${yield* now}
      WHERE folder_id = ${id}
    `.pipe(Effect.mapError(failed("Could not rename the folder.")));
    yield* notify;
  });

  const remove = Effect.fn("FolderStore.remove")(function* (id: FolderId) {
    yield* requireLive(id);
    const at = yield* now;
    yield* sql
      .withTransaction(
        Effect.all([
          sql`UPDATE projection_folders SET deleted_at = ${at}, updated_at = ${at} WHERE folder_id = ${id}`,
          sql`UPDATE merge_thread_links SET folder_id = NULL, updated_at = ${at} WHERE folder_id = ${id}`,
        ]),
      )
      .pipe(Effect.mapError(failed("Could not delete the folder.")));
    yield* notify;
  });

  const assign = Effect.fn("FolderStore.assign")(function* (
    threadId: ThreadId,
    folderId: FolderId | null,
  ) {
    if (folderId !== null) yield* requireLive(folderId);
    const at = yield* now;
    yield* (
      folderId === null
        ? sql`UPDATE merge_thread_links SET folder_id = NULL, updated_at = ${at} WHERE thread_id = ${threadId}`
        : sql`
            INSERT INTO merge_thread_links (thread_id, folder_id, updated_at)
            VALUES (${threadId}, ${folderId}, ${at})
            ON CONFLICT (thread_id) DO UPDATE SET
              folder_id = excluded.folder_id, updated_at = excluded.updated_at
          `
    ).pipe(Effect.mapError(failed("Could not move the thread.")));
    yield* notify;
  });

  // Subscribe before the first emit so a write between the two is never missed.
  const changes = Stream.unwrap(
    Effect.map(PubSub.subscribe(changed), (subscription) =>
      Stream.concat(Stream.succeed(undefined), Stream.fromSubscription(subscription)),
    ),
  );

  return FolderStore.of({ snapshot, create, rename, remove, assign, changes });
});

export const layer = Layer.effect(FolderStore, make);
