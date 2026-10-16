import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { readEnvironmentSupportsFolders } from "../../state/entities";
import { readFolders } from "../../state/folders";
import type { ThreadFolderMenuState } from "../threadActionMenu.logic";

/**
 * Folder options for a thread's action menu: its own environment's folders,
 * since a thread can only be filed where it lives. Null when the server
 * predates folders or the thread belongs to a task (tasks group it already).
 */
export function readThreadFolderMenuState(
  thread: Pick<EnvironmentThreadShell, "environmentId" | "taskId" | "folderId">,
): ThreadFolderMenuState | null {
  if (thread.taskId != null || !readEnvironmentSupportsFolders(thread.environmentId)) return null;
  return {
    currentFolderId: thread.folderId ?? null,
    options: readFolders()
      .filter((folder) => folder.environmentId === thread.environmentId)
      .map((folder) => ({ id: folder.id, title: folder.title })),
  };
}
