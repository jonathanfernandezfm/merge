import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "../auth.ts";
import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "../baseSchemas.ts";

/** Brand stays `FolderId` so v0.0.10 rows and links keep matching. */
export const FolderId = TrimmedNonEmptyString.pipe(Schema.brand("FolderId"));
export type FolderId = typeof FolderId.Type;

const FolderTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(120));

/** A user folder for parking threads; environment-wide, so it has no project. */
export const Folder = Schema.Struct({
  id: FolderId,
  title: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Folder = typeof Folder.Type;

export const FolderLink = Schema.Struct({ threadId: ThreadId, folderId: FolderId });
export type FolderLink = typeof FolderLink.Type;

/** Every live folder and every thread filed in one, sent whole on each change. */
export const FoldersSnapshot = Schema.Struct({
  folders: Schema.Array(Folder),
  links: Schema.Array(FolderLink),
});
export type FoldersSnapshot = typeof FoldersSnapshot.Type;

export const FolderCreateInput = Schema.Struct({ title: FolderTitle });
export type FolderCreateInput = typeof FolderCreateInput.Type;

export const FolderCreateResult = Schema.Struct({ folderId: FolderId });
export type FolderCreateResult = typeof FolderCreateResult.Type;

export const FolderRenameInput = Schema.Struct({ folderId: FolderId, title: FolderTitle });
export type FolderRenameInput = typeof FolderRenameInput.Type;

export const FolderIdInput = Schema.Struct({ folderId: FolderId });
export type FolderIdInput = typeof FolderIdInput.Type;

/** Files a thread in a folder; null takes it out. */
export const FolderAssignInput = Schema.Struct({
  threadId: ThreadId,
  folderId: Schema.NullOr(FolderId),
});
export type FolderAssignInput = typeof FolderAssignInput.Type;

export class FolderOperationError extends Schema.TaggedError<FolderOperationError>()(
  "FolderOperationError",
  {
    reason: Schema.Literals(["not-found", "failed"]),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const FoldersError = Schema.Union([FolderOperationError, EnvironmentAuthorizationError]);
