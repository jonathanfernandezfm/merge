import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { arrayElementsEqual } from "@t3tools/client-runtime/state/entities";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import {
  MERGE_WS_METHODS,
  type ContextMenuItem,
  type EnvironmentId,
  type FolderLink,
  type FoldersSnapshot,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { toastManager } from "~/components/ui/toast";
import { environmentCatalog } from "~/connection/catalog";
import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentThreadShells } from "~/state/threads";
import {
  buildFolderViews,
  filedThreadKeys,
  folderMenuItems,
  unfiledThreads,
  type EnvironmentFolder,
  type FolderMenuId,
  type FolderView,
} from "./logic";

const live = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:merge:folders",
  tag: MERGE_WS_METHODS.foldersSubscribe,
});

export const foldersEnvironment = {
  create: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:merge:folders-create",
    tag: MERGE_WS_METHODS.foldersCreate,
  }),
  rename: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:merge:folders-rename",
    tag: MERGE_WS_METHODS.foldersRename,
  }),
  delete: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:merge:folders-delete",
    tag: MERGE_WS_METHODS.foldersDelete,
  }),
  assign: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:merge:folders-assign",
    tag: MERGE_WS_METHODS.foldersAssign,
    concurrency: {
      mode: "serial",
      key: ({ environmentId, input }) => `${environmentId}:${input.threadId}`,
    },
  }),
};

/** Runs a folder command outside React and toasts a failure. */
export async function runFolderCommand<W, A, E>(
  command: AtomCommand<W, A, E>,
  input: W,
  title: string,
): Promise<A | null> {
  const result = await runAtomCommand(appAtomRegistry, command, input, { reportFailure: false });
  if (result._tag === "Success") return result.value;
  if (!isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : undefined,
    });
  }
  return null;
}

/** Null while loading and for environments whose server has no folders (stream failed). */
const snapshotAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): FoldersSnapshot | null =>
    Option.getOrNull(AsyncResult.value(get(live({ environmentId, input: {} })))),
  ).pipe(Atom.withLabel(`merge-folders-snapshot:${environmentId}`)),
);

const scopedFolders = new WeakMap<object, EnvironmentFolder>();
let previousFolders: ReadonlyArray<EnvironmentFolder> = [];
const foldersAtom = Atom.make((get) => {
  const next: EnvironmentFolder[] = [];
  for (const environmentId of enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))) {
    for (const folder of get(snapshotAtom(environmentId))?.folders ?? []) {
      let scoped = scopedFolders.get(folder);
      if (scoped === undefined) {
        scoped = { ...folder, environmentId };
        scopedFolders.set(folder, scoped);
      }
      next.push(scoped);
    }
  }
  if (arrayElementsEqual(previousFolders, next)) return previousFolders;
  previousFolders = next;
  return next;
}).pipe(Atom.withLabel("merge-folders"));

const EMPTY_LINKS: ReadonlyArray<FolderLink> = [];

const filedAtom = Atom.make((get) => {
  const links = new Map<EnvironmentId, ReadonlyArray<FolderLink>>();
  for (const environmentId of enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))) {
    links.set(environmentId, get(snapshotAtom(environmentId))?.links ?? EMPTY_LINKS);
  }
  return filedThreadKeys(get(foldersAtom), links);
}).pipe(Atom.withLabel("merge-folders-filed"));

export function useFolderViews(query: string): ReadonlyArray<FolderView> {
  const folders = useAtomValue(foldersAtom);
  const filed = useAtomValue(filedAtom);
  const shells = useAtomValue(environmentThreadShells.quietThreadShellsAtom);
  return buildFolderViews({ folders, filed, shells, query });
}

let previousEnvironments: ReadonlyArray<EnvironmentId> = [];
const folderEnvironmentsAtom = Atom.make((get) => {
  const next = [...enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))].filter(
    (environmentId) => get(snapshotAtom(environmentId)) !== null,
  );
  if (arrayElementsEqual(previousEnvironments, next)) return previousEnvironments;
  previousEnvironments = next;
  return next;
}).pipe(Atom.withLabel("merge-folders-environments"));

/** Environments whose server streams folders; the section offers New folder there. */
export function useFolderEnvironments(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(folderEnvironmentsAtom);
}

/** At the `folders` seam: the Threads list leaves filed threads to the Folders section. */
export function useMergeUnfiledThreads<
  T extends Pick<EnvironmentThreadShell, "environmentId" | "id">,
>(threads: ReadonlyArray<T>): ReadonlyArray<T> {
  const filed = useAtomValue(filedAtom);
  return unfiledThreads(threads, filed);
}

/** Keeps every environment's folder stream open; mounted by the always-mounted dialogs host. */
export function useKeepFoldersLive(): void {
  useAtomValue(filedAtom);
}

export function readFolder(environmentId: EnvironmentId, folderId: string) {
  return (
    appAtomRegistry
      .get(foldersAtom)
      .find((folder) => folder.environmentId === environmentId && folder.id === folderId) ?? null
  );
}

/** The thread menu's folder entries; none where the server has no folders. */
export function readFolderMenuItems(
  threadRef: ScopedThreadRef,
): ReadonlyArray<ContextMenuItem<FolderMenuId>> {
  const snapshot = appAtomRegistry.get(snapshotAtom(threadRef.environmentId));
  if (snapshot === null) return [];
  const folders = appAtomRegistry
    .get(foldersAtom)
    .filter((folder) => folder.environmentId === threadRef.environmentId);
  const current = snapshot.links.find((link) => link.threadId === threadRef.threadId)?.folderId;
  return folderMenuItems({
    folders,
    currentFolderId: folders.some((folder) => folder.id === current) ? (current ?? null) : null,
  });
}
