import { FolderId } from "@t3tools/contracts";

import type { MergeThreadMenuProvider } from "../threadMenu";
import { readThreadInWorkTask } from "../workTasks/state";
import { openNewFolderDialog } from "./FolderDialogs";
import { parseFolderMenuId } from "./logic";
import { foldersEnvironment, readFolderMenuItems, runFolderCommand } from "./state";

/** "Move to folder" and "Remove from folder" in every thread menu. */
export const folderThreadMenu: MergeThreadMenuProvider = {
  // A Work Task already groups its threads, as in v0.0.10.
  items: (threadRef) => (readThreadInWorkTask(threadRef) ? [] : readFolderMenuItems(threadRef)),
  handle: (clicked, threadRef) => {
    const action = parseFolderMenuId(clicked);
    if (action === null) return false;
    if (action.kind === "new") {
      openNewFolderDialog(threadRef.environmentId, threadRef);
      return true;
    }
    void runFolderCommand(
      foldersEnvironment.assign,
      {
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          folderId: action.kind === "move" ? FolderId.make(action.folderId) : null,
        },
      },
      "Could not move the thread",
    );
    return true;
  },
};
