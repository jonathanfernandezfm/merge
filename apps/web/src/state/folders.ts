import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentFolderAtoms,
  createFolderEnvironmentAtoms,
  type EnvironmentFolder,
} from "@t3tools/client-runtime/state/folders";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSnapshotAtom } from "./shell";

export type { EnvironmentFolder };

export const folderEnvironment = createFolderEnvironmentAtoms(connectionAtomRuntime);
const environmentFolders = createEnvironmentFolderAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
});

/** Every live folder across enabled environments, oldest first per environment. */
export function useFolders(): ReadonlyArray<EnvironmentFolder> {
  return useAtomValue(environmentFolders.foldersAtom);
}

export function readFolders(): ReadonlyArray<EnvironmentFolder> {
  return appAtomRegistry.get(environmentFolders.foldersAtom);
}

export function folderKey(folder: Pick<EnvironmentFolder, "environmentId" | "id">): string {
  return `${folder.environmentId}:${folder.id}`;
}
