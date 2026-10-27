import { useAtomValue } from "@effect/atom-react";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useId, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { readLocalApi } from "~/localApi";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import type { EnvironmentFolder } from "./logic";
import { foldersEnvironment, runFolderCommand } from "./state";

type NameRequest =
  | {
      readonly mode: "create";
      readonly environmentId: EnvironmentId;
      /** Filed in the new folder once it exists ("Move to folder → New folder…"). */
      readonly thread?: ScopedThreadRef;
    }
  | { readonly mode: "rename"; readonly folder: EnvironmentFolder };

const nameDialogAtom = Atom.make<NameRequest | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("merge-folders:name-dialog"),
);

export function openNewFolderDialog(environmentId: EnvironmentId, thread?: ScopedThreadRef): void {
  appAtomRegistry.set(nameDialogAtom, {
    mode: "create",
    environmentId,
    ...(thread ? { thread } : {}),
  });
}

export function openRenameFolderDialog(folder: EnvironmentFolder): void {
  appAtomRegistry.set(nameDialogAtom, { mode: "rename", folder });
}

/** Threads in the folder move back to Threads; none is deleted. */
export async function confirmDeleteFolder(folder: EnvironmentFolder): Promise<void> {
  const api = readLocalApi();
  if (!api) return;
  const confirmed = await settlePromise(() =>
    api.dialogs.confirm(
      `Delete folder "${folder.title}"?\nThreads in this folder move back to Threads.`,
      { variant: "destructive" },
    ),
  );
  if (confirmed._tag === "Failure" || !confirmed.value) return;
  await runFolderCommand(
    foldersEnvironment.delete,
    { environmentId: folder.environmentId, input: { folderId: folder.id } },
    "Could not delete the folder",
  );
}

/** Rendered by the always-mounted Work Task dialogs host. */
export function FolderDialogsHost() {
  const request = useAtomValue(nameDialogAtom);
  return request === null ? null : (
    <FolderNameDialog request={request} onClose={() => appAtomRegistry.set(nameDialogAtom, null)} />
  );
}

async function submit(request: NameRequest, title: string): Promise<void> {
  if (request.mode === "rename") {
    if (title === request.folder.title) return;
    await runFolderCommand(
      foldersEnvironment.rename,
      {
        environmentId: request.folder.environmentId,
        input: { folderId: request.folder.id, title },
      },
      "Could not rename the folder",
    );
    return;
  }
  const created = await runFolderCommand(
    foldersEnvironment.create,
    { environmentId: request.environmentId, input: { title } },
    "Could not create the folder",
  );
  if (created === null || request.thread === undefined) return;
  await runFolderCommand(
    foldersEnvironment.assign,
    {
      environmentId: request.environmentId,
      input: { threadId: request.thread.threadId, folderId: created.folderId },
    },
    "Could not move the thread",
  );
}

function FolderNameDialog({ request, onClose }: { request: NameRequest; onClose: () => void }) {
  const id = useId();
  const [name, setName] = useState(request.mode === "rename" ? request.folder.title : "");
  const [pending, setPending] = useState(false);
  const trimmed = name.trim();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed.length === 0 || pending) return;
            setPending(true);
            void submit(request, trimmed).finally(onClose);
          }}
        >
          <DialogHeader>
            <DialogTitle>{request.mode === "rename" ? "Rename folder" : "New folder"}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <Label className="flex flex-col items-stretch" htmlFor={id}>
              Name
              <Input
                nativeInput
                id={id}
                autoFocus
                maxLength={120}
                value={name}
                onChange={(event) => setName(event.target.value)}
                onFocus={(event) => event.currentTarget.select()}
              />
            </Label>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={trimmed.length === 0 || pending}>
              {request.mode === "rename" ? "Rename" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
