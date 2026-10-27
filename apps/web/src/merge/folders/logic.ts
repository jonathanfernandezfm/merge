import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  ContextMenuItem,
  EnvironmentId,
  Folder,
  FolderId,
  FolderLink,
} from "@t3tools/contracts";

import { isSidebarSubagentThread, sortThreadsForSidebar } from "~/components/Sidebar.logic";

export interface EnvironmentFolder extends Folder {
  readonly environmentId: EnvironmentId;
}

export interface FolderView {
  readonly key: string;
  readonly folder: EnvironmentFolder;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}

export type FolderMenuId = `merge:folder:${string}`;

export function folderKey(environmentId: EnvironmentId, folderId: FolderId): string {
  return `${environmentId}\u0000${folderId}`;
}

/**
 * Scoped keys of threads filed in a folder this client knows. A thread whose folder has not
 * loaded yet never disappears from the Threads list.
 */
export function filedThreadKeys(
  folders: ReadonlyArray<EnvironmentFolder>,
  linksByEnvironment: ReadonlyMap<EnvironmentId, ReadonlyArray<FolderLink>>,
): ReadonlyMap<string, string> {
  const live = new Set(folders.map((folder) => folderKey(folder.environmentId, folder.id)));
  const filed = new Map<string, string>();
  for (const [environmentId, links] of linksByEnvironment) {
    for (const link of links) {
      const key = folderKey(environmentId, link.folderId);
      if (live.has(key))
        filed.set(scopedThreadKey(scopeThreadRef(environmentId, link.threadId)), key);
    }
  }
  return filed;
}

/** The Threads list without filed threads; the same array when none is filed. */
export function unfiledThreads<T extends Pick<EnvironmentThreadShell, "environmentId" | "id">>(
  threads: ReadonlyArray<T>,
  filed: ReadonlyMap<string, string>,
): ReadonlyArray<T> {
  if (filed.size === 0) return threads;
  const kept = threads.filter(
    (thread) => !filed.has(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
  );
  return kept.length === threads.length ? threads : kept;
}

/**
 * Folders with their live threads in Threads-list order. A search keeps folders whose title
 * matches (with every thread) and folders with a matching thread (with those threads).
 */
export function buildFolderViews(input: {
  readonly folders: ReadonlyArray<EnvironmentFolder>;
  readonly filed: ReadonlyMap<string, string>;
  readonly shells: ReadonlyArray<EnvironmentThreadShell>;
  readonly query?: string;
}): ReadonlyArray<FolderView> {
  const byFolder = new Map<string, EnvironmentThreadShell[]>();
  for (const shell of input.shells) {
    if (shell.archivedAt !== null || isSidebarSubagentThread(shell)) continue;
    const key = input.filed.get(scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id)));
    if (key === undefined) continue;
    const list = byFolder.get(key);
    if (list === undefined) byFolder.set(key, [shell]);
    else list.push(shell);
  }
  const query = input.query?.trim().toLowerCase() ?? "";
  const matches = (text: string) => text.toLowerCase().includes(query);
  return input.folders.flatMap((folder) => {
    const key = folderKey(folder.environmentId, folder.id);
    const threads = sortThreadsForSidebar(byFolder.get(key) ?? []);
    if (query.length === 0 || matches(folder.title)) return [{ key, folder, threads }];
    const found = threads.filter((thread) => matches(thread.title));
    return found.length > 0 ? [{ key, folder, threads: found }] : [];
  });
}

/** "Move to folder" for a thread's menu: its own environment's folders, and the way out. */
export function folderMenuItems(input: {
  readonly folders: ReadonlyArray<Pick<Folder, "id" | "title">>;
  readonly currentFolderId: FolderId | null;
}): ReadonlyArray<ContextMenuItem<FolderMenuId>> {
  return [
    {
      id: "merge:folder:menu",
      label: "Move to folder",
      icon: "folder",
      children: [
        ...input.folders.map((folder) => ({
          id: `merge:folder:move:${folder.id}` as const,
          label: folder.title,
          checked: folder.id === input.currentFolderId,
        })),
        {
          id: "merge:folder:new" as const,
          label: "New folder…",
          separatorBefore: input.folders.length > 0,
        },
      ],
    },
    ...(input.currentFolderId !== null
      ? [{ id: "merge:folder:remove" as const, label: "Remove from folder", icon: "folder" }]
      : []),
  ];
}

export type FolderMenuAction =
  | { readonly kind: "move"; readonly folderId: string }
  | { readonly kind: "new" }
  | { readonly kind: "remove" };

export function parseFolderMenuId(id: string): FolderMenuAction | null {
  if (id === "merge:folder:new") return { kind: "new" };
  if (id === "merge:folder:remove") return { kind: "remove" };
  const prefix = "merge:folder:move:";
  return id.startsWith(prefix) ? { kind: "move", folderId: id.slice(prefix.length) } : null;
}
