import type {
  EnvironmentId,
  FolderId,
  OrchestrationFolder,
  OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  type CreateFolderInput,
  type DeleteFolderInput,
  type RenameFolderInput,
  createFolder,
  deleteFolder,
  renameFolder,
} from "../operations/commands.ts";
import { type EnvironmentCatalogState, enabledEnvironmentIds } from "./connections.ts";
import { arrayElementsEqual } from "./entities.ts";
import { createAtomCommandScheduler, createEnvironmentCommand } from "./runtime.ts";

export type { CreateFolderInput, DeleteFolderInput, RenameFolderInput };

export interface EnvironmentFolder extends OrchestrationFolder {
  readonly environmentId: EnvironmentId;
}

const EMPTY_FOLDERS: ReadonlyArray<OrchestrationFolder> = Object.freeze([]);

/** Live folders from each environment's shell snapshot, scoped like projects. */
export function createEnvironmentFolderAtoms(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly snapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationShellSnapshot | null>;
}) {
  // One scoped object per source folder so unchanged folders keep identity.
  const scopedFolders = new WeakMap<OrchestrationFolder, EnvironmentFolder>();
  const scopeFolder = (environmentId: EnvironmentId, folder: OrchestrationFolder) => {
    let value = scopedFolders.get(folder);
    if (value === undefined) {
      value = { ...folder, environmentId };
      scopedFolders.set(folder, value);
    }
    return value;
  };

  const environmentFoldersAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): ReadonlyArray<OrchestrationFolder> =>
        get(input.snapshotAtom(environmentId))?.folders ?? EMPTY_FOLDERS,
    ).pipe(Atom.withLabel(`environment-folders:${environmentId}`)),
  );

  // Every live folder in every enabled environment, oldest first per environment.
  let previousFolders: ReadonlyArray<EnvironmentFolder> = [];
  const foldersAtom = Atom.make((get) => {
    const next: EnvironmentFolder[] = [];
    for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
      for (const folder of get(environmentFoldersAtom(environmentId))) {
        if (folder.deletedAt !== null) continue;
        next.push(scopeFolder(environmentId, folder));
      }
    }
    if (arrayElementsEqual(previousFolders, next)) return previousFolders;
    previousFolders = next;
    return previousFolders;
  }).pipe(Atom.withLabel("environment-folder-list"));

  return { environmentFoldersAtom, foldersAtom };
}

/** Folder create / rename / delete commands. */
export function createFolderEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { folderId: FolderId } }) =>
      JSON.stringify([environmentId, input.folderId]),
  };
  return {
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:folder:create",
      execute: (input: CreateFolderInput) => createFolder(input),
      scheduler,
      concurrency,
    }),
    rename: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:folder:rename",
      execute: (input: RenameFolderInput) => renameFolder(input),
      scheduler,
      concurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:folder:delete",
      execute: (input: DeleteFolderInput) => deleteFolder(input),
      scheduler,
      concurrency,
    }),
  };
}
