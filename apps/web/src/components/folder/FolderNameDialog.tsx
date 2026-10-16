import { useEffect, useId, useState } from "react";
import { create } from "zustand";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

interface FolderNameRequest {
  readonly title: string;
  readonly submitLabel: string;
  readonly initialName: string;
  readonly resolve: (name: string | null) => void;
}

const useRequest = create<{ request: FolderNameRequest | null }>(() => ({ request: null }));

/** Asks for a folder name; resolves to the trimmed name, or null when cancelled. */
export function requestFolderName(input: {
  readonly title: string;
  readonly submitLabel: string;
  readonly initialName?: string;
}): Promise<string | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) =>
    useRequest.setState({
      request: {
        title: input.title,
        submitLabel: input.submitLabel,
        initialName: input.initialName ?? "",
        resolve,
      },
    }),
  );
}

function finish(name: string | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(name);
}

export function FolderNameDialogHost() {
  const request = useRequest((state) => state.request);
  useEffect(() => () => finish(null), []);
  return request ? <FolderNameDialog request={request} /> : null;
}

function FolderNameDialog({ request }: { request: FolderNameRequest }) {
  const id = useId();
  const [name, setName] = useState(request.initialName);
  const trimmed = name.trim();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed.length > 0) finish(trimmed);
          }}
        >
          <DialogHeader>
            <DialogTitle>{request.title}</DialogTitle>
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
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={trimmed.length === 0}>
              {request.submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
