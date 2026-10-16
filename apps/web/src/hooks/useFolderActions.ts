import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { FolderId, type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { requestFolderName } from "../components/folder/FolderNameDialog";
import { randomUUID } from "../lib/utils";
import { readLocalApi } from "../localApi";
import { type EnvironmentFolder, folderEnvironment } from "../state/folders";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";

/**
 * Folder mutations shared by the sidebar Folders section and the thread
 * action menus. Failures report through the command runner's toast.
 */
export function useFolderActions() {
  const createFolder = useAtomCommand(folderEnvironment.create, "create folder");
  const renameFolder = useAtomCommand(folderEnvironment.rename, "rename folder");
  const deleteFolder = useAtomCommand(folderEnvironment.delete, "delete folder");
  const setThreadFolder = useAtomCommand(threadEnvironment.setFolder, "move thread");

  /** Prompts for a name and creates the folder; resolves to its id, or null. */
  const promptCreateFolder = useCallback(
    async (environmentId: EnvironmentId): Promise<FolderId | null> => {
      const title = await requestFolderName({ title: "New folder", submitLabel: "Create" });
      if (title === null) return null;
      const folderId = FolderId.make(randomUUID());
      const result = await createFolder({ environmentId, input: { folderId, title } });
      return result._tag === "Success" ? folderId : null;
    },
    [createFolder],
  );

  const moveThreadToFolder = useCallback(
    (threadRef: ScopedThreadRef, folderId: FolderId | null) =>
      setThreadFolder({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, folderId },
      }),
    [setThreadFolder],
  );

  const moveThreadToNewFolder = useCallback(
    async (threadRef: ScopedThreadRef) => {
      const folderId = await promptCreateFolder(threadRef.environmentId);
      if (folderId !== null) await moveThreadToFolder(threadRef, folderId);
    },
    [moveThreadToFolder, promptCreateFolder],
  );

  const promptRenameFolder = useCallback(
    async (folder: EnvironmentFolder) => {
      const title = await requestFolderName({
        title: "Rename folder",
        submitLabel: "Rename",
        initialName: folder.title,
      });
      if (title === null || title === folder.title) return;
      await renameFolder({
        environmentId: folder.environmentId,
        input: { folderId: folder.id, title },
      });
    },
    [renameFolder],
  );

  const confirmDeleteFolder = useCallback(
    async (folder: EnvironmentFolder) => {
      const api = readLocalApi();
      if (!api) return;
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(
          [`Delete folder "${folder.title}"?`, "Threads in this folder move back to Threads."].join(
            "\n",
          ),
          { variant: "destructive" },
        ),
      );
      if (confirmed._tag === "Failure" || !confirmed.value) return;
      await deleteFolder({ environmentId: folder.environmentId, input: { folderId: folder.id } });
    },
    [deleteFolder],
  );

  return useMemo(
    () => ({
      promptCreateFolder,
      moveThreadToFolder,
      moveThreadToNewFolder,
      promptRenameFolder,
      confirmDeleteFolder,
    }),
    [
      confirmDeleteFolder,
      moveThreadToFolder,
      moveThreadToNewFolder,
      promptCreateFolder,
      promptRenameFolder,
    ],
  );
}
