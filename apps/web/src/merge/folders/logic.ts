import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  ContextMenuItem,
  EnvironmentId,
  Folder,
  FolderId,
  FolderLink,
} from "@t3tools/contracts";

import { filterSidebarV2VisibleThreads, sortThreadsForSidebar } from "~/components/Sidebar.logic";

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
 * Filed threads the Threads list would show: live, top-level, in the sidebar's project scope.
 * Upstream's search gets them back through the `folders` seam.
 */
export function filedVisibleThreads(
  shells: ReadonlyArray<EnvironmentThreadShell>,
  filed: ReadonlyMap<string, string>,
  scopedProjectKeys: ReadonlySet<string> | null,
): ReadonlyArray<EnvironmentThreadShell> {
  if (filed.size === 0) return [];
  return filterSidebarV2VisibleThreads(
    shells.filter((shell) =>
      filed.has(scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id))),
    ),
    scopedProjectKeys,
  );
}

/** Every folder with its visible threads in Threads-list order; folders stay when the scope empties them. */
export function buildFolderViews(input: {
  readonly folders: ReadonlyArray<EnvironmentFolder>;
  readonly filed: ReadonlyMap<string, string>;
  readonly shells: ReadonlyArray<EnvironmentThreadShell>;
  readonly scopedProjectKeys: ReadonlySet<string> | null;
}): ReadonlyArray<FolderView> {
  const byFolder = new Map<string, EnvironmentThreadShell[]>();
  for (const shell of filedVisibleThreads(input.shells, input.filed, input.scopedProjectKeys)) {
    const key = input.filed.get(scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id)));
    if (key === undefined) continue;
    const list = byFolder.get(key);
    if (list === undefined) byFolder.set(key, [shell]);
    else list.push(shell);
  }
  return input.folders.map((folder) => {
    const key = folderKey(folder.environmentId, folder.id);
    return { key, folder, threads: sortThreadsForSidebar(byFolder.get(key) ?? []) };
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
