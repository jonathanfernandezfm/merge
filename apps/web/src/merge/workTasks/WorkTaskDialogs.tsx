import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  WorkTaskOperationError,
  type EnvironmentId,
  type ProjectId,
  type WorkTaskArchiveBlocker,
  type WorkTaskId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import { GitBranchIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "~/components/ui/combobox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useProjects, waitForThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { readEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { remoteBranchOf, workTaskTitleFromBranch } from "./logic";
import { useWorkTaskView, workTasksEnvironment } from "./state";

export interface WorkTaskRef {
  readonly environmentId: EnvironmentId;
  readonly taskId: WorkTaskId;
}

interface NewWorkTaskTarget {
  readonly environmentId?: EnvironmentId;
  readonly projectId?: ProjectId;
}

// Set by whichever entry point asked and rendered once by the host, so a dialog outlives the
// palette or menu that opened it.
const newDialogAtom = Atom.make<NewWorkTaskTarget | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("merge-work-tasks:new-dialog"),
);
const archiveDialogAtom = Atom.make<WorkTaskRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("merge-work-tasks:archive-dialog"),
);
const waitingDialogAtom = Atom.make<WorkTaskRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("merge-work-tasks:waiting-dialog"),
);

export function openNewWorkTaskDialog(target: NewWorkTaskTarget = {}): void {
  appAtomRegistry.set(newDialogAtom, target);
}

export function openArchiveWorkTaskDialog(ref: WorkTaskRef): void {
  appAtomRegistry.set(archiveDialogAtom, ref);
}

export function openWaitingReasonDialog(ref: WorkTaskRef): void {
  appAtomRegistry.set(waitingDialogAtom, ref);
}

const isWorkTaskOperationError = Schema.is(WorkTaskOperationError);

function commandErrorMessage(result: AtomCommandResult<unknown, unknown>, fallback: string) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

/** Mounted once by the `_chat` layout (`work-task-dialogs` seam). */
export function WorkTaskDialogsHost() {
  const newTarget = useAtomValue(newDialogAtom);
  const archiveTarget = useAtomValue(archiveDialogAtom);
  const waitingTarget = useAtomValue(waitingDialogAtom);
  return (
    <>
      {newTarget !== null ? (
        <NewWorkTaskDialog
          target={newTarget}
          onClose={() => appAtomRegistry.set(newDialogAtom, null)}
        />
      ) : null}
      {archiveTarget !== null ? (
        <ArchiveWorkTaskDialog
          taskRef={archiveTarget}
          onClose={() => appAtomRegistry.set(archiveDialogAtom, null)}
        />
      ) : null}
      {waitingTarget !== null ? (
        <WaitingReasonDialog
          taskRef={waitingTarget}
          onClose={() => appAtomRegistry.set(waitingDialogAtom, null)}
        />
      ) : null}
    </>
  );
}

const REF_LIMIT = 100;

/** `remoteName` is absent for a local branch; the server uses the project's default remote. */
type BranchChoice = { remoteName?: string; branch: string };

function NewWorkTaskDialog({
  target,
  onClose,
}: {
  target: NewWorkTaskTarget;
  onClose: () => void;
}) {
  // Read-only connections cannot create Work Tasks, so their projects are not offered.
  const projects = useProjects().filter((project) =>
    readEnvironmentScope(project.environmentId, AuthOrchestrationOperateScope),
  );
  const navigate = useNavigate();
  const formId = useId();
  const [projectKey, setProjectKey] = useState<string | null>(() => {
    const initial =
      projects.find(
        (project) =>
          project.environmentId === target.environmentId && project.id === target.projectId,
      ) ?? (projects.length === 1 ? projects[0] : undefined);
    return initial ? `${initial.environmentId}:${initial.id}` : null;
  });
  const project =
    projects.find((candidate) => `${candidate.environmentId}:${candidate.id}` === projectKey) ??
    null;
  const projectItems = projects.map((candidate) => ({
    value: `${candidate.environmentId}:${candidate.id}`,
    label: candidate.title,
  }));
  const [title, setTitle] = useState("");
  // Until the user writes their own title, it follows the chosen branch.
  const [titleEdited, setTitleEdited] = useState(false);
  const [description, setDescription] = useState("");
  const [autoHandleReviewFeedback, setAutoHandleReviewFeedback] = useState(true);
  const [branchQuery, setBranchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selectedRefName, setSelectedRefName] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Another worktree holds the chosen branch; the user can detach it.
  const [heldAt, setHeldAt] = useState<{ branch: string; path: string } | null>(null);
  const createWorkTask = useAtomCommand(workTasksEnvironment.create, { reportFailure: false });

  // oxlint-disable-next-line t3code/react-effect-budget -- debounces typing before a git query
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(branchQuery.trim()), 200);
    return () => window.clearTimeout(timeout);
  }, [branchQuery]);

  // Only the unfiltered remote list fetches (through the fork RPC); typing filters what that
  // fetch brought in instead of fetching on every keystroke.
  const query =
    selectedRefName !== null && debouncedQuery === selectedRefName ? "" : debouncedQuery;
  const localRefs = useEnvironmentQuery(
    project === null
      ? null
      : vcsEnvironment.listRefs({
          environmentId: project.environmentId,
          input: {
            cwd: project.workspaceRoot,
            refKind: "local",
            limit: REF_LIMIT,
            ...(query.length > 0 ? { query } : {}),
          },
        }),
  );
  const remoteRefs = useEnvironmentQuery(
    project === null
      ? null
      : query.length > 0
        ? vcsEnvironment.listRefs({
            environmentId: project.environmentId,
            input: {
              cwd: project.workspaceRoot,
              refKind: "remote",
              includeMatchingRemoteRefs: true,
              limit: REF_LIMIT,
              query,
            },
          })
        : workTasksEnvironment.listBranches({
            environmentId: project.environmentId,
            input: {
              projectId: project.id,
              refKind: "remote",
              // A remote branch is still a valid source when a local branch of the same name
              // exists (e.g. left behind by an archived Work Task).
              includeMatchingRemoteRefs: true,
              limit: REF_LIMIT,
            },
          }),
  );
  const branchChoices = new Map<string, BranchChoice>([
    ...(localRefs.data?.refs ?? []).flatMap((ref) =>
      ref.isRemote ? [] : [[ref.name, { branch: ref.name }] as const],
    ),
    ...(remoteRefs.data?.refs ?? []).flatMap((ref) => {
      const remote = remoteBranchOf(ref);
      return remote === null ? [] : [[ref.name, remote] as const];
    }),
  ]);
  const refsPending = localRefs.isPending || remoteRefs.isPending;
  const refsError = localRefs.error ?? remoteRefs.error;
  // Kept apart from the list so a later filtered fetch cannot drop the choice.
  const [chosenBranch, setChosenBranch] = useState<BranchChoice | null>(null);
  const chooseBranch = (choice: BranchChoice | null) => {
    setChosenBranch(choice);
    setHeldAt(null);
    if (!titleEdited) setTitle(choice === null ? "" : workTaskTitleFromBranch(choice.branch));
  };

  const canSubmit =
    !pending && project !== null && title.trim().length > 0 && chosenBranch !== null;

  const submit = async (detachCheckoutAt?: string) => {
    if (!canSubmit || project === null || chosenBranch === null) return;
    setPending(true);
    setError(null);
    setHeldAt(null);
    const result = await createWorkTask({
      environmentId: project.environmentId,
      input: {
        projectId: project.id,
        title: title.trim(),
        ...(description.trim().length > 0 ? { description: description.trim() } : {}),
        ...(chosenBranch.remoteName === undefined ? {} : { remoteName: chosenBranch.remoteName }),
        branch: chosenBranch.branch,
        autoHandleReviewFeedback,
        ...(detachCheckoutAt === undefined ? {} : { detachCheckoutAt }),
      },
    });
    if (result._tag === "Failure") {
      setPending(false);
      const failure = isAtomCommandInterrupted(result) ? null : squashAtomCommandFailure(result);
      if (
        isWorkTaskOperationError(failure) &&
        failure.reason === "branch-checked-out" &&
        failure.checkoutPath !== undefined
      ) {
        setHeldAt({ branch: chosenBranch.branch, path: failure.checkoutPath });
        return;
      }
      setError(commandErrorMessage(result, "Could not create the Work Task."));
      return;
    }
    onClose();
    const threadRef = { environmentId: project.environmentId, threadId: result.value.threadId };
    // The RPC returns before the shell event lands; opening the route early would flash a
    // missing thread.
    await waitForThreadShell(threadRef).catch(() => undefined);
    await navigate({ to: "/$environmentId/$threadId", params: threadRef });
  };

  return (
    <Dialog open onOpenChange={(open) => (!open && !pending ? onClose() : undefined)}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>New Work Task</DialogTitle>
          <DialogDescription>
            A Work Task works on an existing branch in its own worktree. It checks the branch out
            and never creates one.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-project`}>Project</Label>
              <Select
                items={projectItems}
                value={projectKey}
                onValueChange={(value) => {
                  setProjectKey(value);
                  setSelectedRefName(null);
                  chooseBranch(null);
                  setBranchQuery("");
                }}
              >
                <SelectTrigger id={`${formId}-project`}>
                  <SelectValue placeholder="Choose a project" />
                </SelectTrigger>
                <SelectPopup>
                  {projectItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-branch`}>Branch</Label>
              <Combobox
                items={[...branchChoices.keys()]}
                value={selectedRefName}
                onValueChange={(value: string | null) => {
                  setSelectedRefName(value);
                  chooseBranch(value === null ? null : (branchChoices.get(value) ?? null));
                  if (value !== null) setBranchQuery(value);
                }}
                inputValue={branchQuery}
                onInputValueChange={(value: string) => {
                  setBranchQuery(value);
                  // Typing past a selection drops it, so submit never uses a branch other than
                  // the one the field shows.
                  if (selectedRefName !== null && value !== selectedRefName) {
                    setSelectedRefName(null);
                    chooseBranch(null);
                  }
                }}
                disabled={project === null}
              >
                <ComboboxInput
                  id={`${formId}-branch`}
                  placeholder={
                    project === null
                      ? "Choose a project first"
                      : "feature-branch or origin/feature-branch"
                  }
                  startAddon={<GitBranchIcon />}
                />
                <ComboboxPopup>
                  <ComboboxEmpty>
                    {refsPending ? "Loading branches..." : (refsError ?? "No matching branch.")}
                  </ComboboxEmpty>
                  <ComboboxList>
                    {(name: string) => (
                      <ComboboxItem key={name} value={name}>
                        <span className="min-w-0 truncate">{name}</span>
                      </ComboboxItem>
                    )}
                  </ComboboxList>
                </ComboboxPopup>
              </Combobox>
              <p className="text-muted-foreground text-xs">
                {chosenBranch === null
                  ? "Pick an existing local or remote branch."
                  : chosenBranch.remoteName === undefined
                    ? `Checks out local branch ${chosenBranch.branch}.`
                    : `Checks out ${chosenBranch.branch} tracking ${chosenBranch.remoteName}/${chosenBranch.branch}.`}
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-title`}>Title</Label>
              <Input
                id={`${formId}-title`}
                placeholder="ABC-123 Permissions"
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                  setTitleEdited(event.target.value.trim().length > 0);
                }}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-description`}>Description (optional)</Label>
              <Textarea
                id={`${formId}-description`}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
            <Label>
              <Checkbox
                checked={autoHandleReviewFeedback}
                onCheckedChange={(checked) => setAutoHandleReviewFeedback(checked === true)}
              />
              Auto-handle review feedback
            </Label>
            {heldAt !== null ? (
              <div className="flex items-center gap-2">
                <p className="min-w-0 flex-1 text-warning-foreground text-xs">
                  {heldAt.branch} is checked out at {heldAt.path}. Detaching switches that worktree
                  to a detached HEAD; its files and uncommitted changes stay there.
                </p>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={pending}
                  onClick={() => void submit(heldAt.path)}
                >
                  Detach and continue
                </Button>
              </div>
            ) : null}
            {error !== null ? <p className="text-destructive-foreground text-xs">{error}</p> : null}
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} size="sm" disabled={!canSubmit}>
            {pending ? <Spinner /> : null}
            {pending ? "Creating..." : "Create Work Task"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

const ARCHIVE_BLOCKER_COPY: Readonly<Record<WorkTaskArchiveBlocker, string>> = {
  "uncommitted-changes": "The workspace has uncommitted changes. They will be lost.",
  "unpushed-commits": "Some commits were never pushed. They will be lost.",
  "pull-request-open": "The pull request is still open.",
  "agent-running": "An agent is still running. It will be stopped.",
};

function ArchiveWorkTaskDialog({
  taskRef,
  onClose,
}: {
  taskRef: WorkTaskRef;
  onClose: () => void;
}) {
  const view = useWorkTaskView(taskRef.environmentId, taskRef.taskId);
  const navigate = useNavigate();
  const archiveTask = useAtomCommand(workTasksEnvironment.archive, { reportFailure: false });
  const check = useEnvironmentQuery(
    workTasksEnvironment.archiveCheck({
      environmentId: taskRef.environmentId,
      input: { taskId: taskRef.taskId },
    }),
  );
  const blockers = check.data?.blockers ?? null;
  const checking = check.isPending && blockers === null;
  const checkError = check.error;

  // Archiving removes the worktree and can take a while, so the dialog closes right away and a
  // toast tracks the outcome. The command runs through the atom registry, so it survives unmount.
  const confirm = async () => {
    if (blockers === null) return;
    const title = view?.task.title ?? "Work Task";
    onClose();
    // The open thread now belongs to an archived task; the board keeps archived tasks.
    void navigate({ to: "/work-tasks" });
    const toastId = toastManager.add({
      type: "loading",
      title: `Archiving ${title}...`,
      timeout: 0,
    });
    const result = await archiveTask({
      environmentId: taskRef.environmentId,
      input: { taskId: taskRef.taskId, ...(blockers.length > 0 ? { force: true } : {}) },
    });
    if (result._tag === "Success") {
      toastManager.update(toastId, { type: "success", title: `Archived ${title}`, timeout: 4000 });
      return;
    }
    // A blocker can appear between the check and the archive; offer to review it.
    toastManager.update(toastId, {
      type: "error",
      title: `Could not archive ${title}`,
      description: commandErrorMessage(result, "Could not archive the Work Task."),
      timeout: 0,
      actionProps: { children: "Review", onClick: () => openArchiveWorkTaskDialog(taskRef) },
    });
  };

  const hasBlockers = blockers !== null && blockers.length > 0;
  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Archive {view?.task.title ?? "Work Task"}?</DialogTitle>
          <DialogDescription>
            Archiving stops the Work Task's agents and removes its worktree. The remote branch is
            kept, and its threads and pull request stay in its history.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {checking ? (
            <p className="flex items-center gap-2 text-muted-foreground text-sm">
              <Spinner />
              Checking the workspace...
            </p>
          ) : null}
          {!checking && checkError !== null ? (
            <div className="flex items-center gap-2">
              <p className="min-w-0 flex-1 text-destructive-foreground text-xs">{checkError}</p>
              <Button type="button" size="xs" variant="outline" onClick={() => check.refresh()}>
                Retry check
              </Button>
            </div>
          ) : null}
          {hasBlockers ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm">Before you archive:</p>
              <ul className="flex list-disc flex-col gap-1 ps-5 text-sm text-warning-foreground">
                {blockers.map((blocker) => (
                  <li key={blocker}>{ARCHIVE_BLOCKER_COPY[blocker]}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={checking || blockers === null}
            onClick={() => void confirm()}
          >
            {hasBlockers ? "Archive anyway" : "Archive Work Task"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function WaitingReasonDialog({ taskRef, onClose }: { taskRef: WorkTaskRef; onClose: () => void }) {
  const view = useWorkTaskView(taskRef.environmentId, taskRef.taskId);
  const setWaiting = useAtomCommand(workTasksEnvironment.setWaiting, { reportFailure: false });
  const [reason, setReason] = useState(view?.task.waitingForUserReason ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = reason.trim();
    if (pending || trimmed.length === 0) return;
    setPending(true);
    setError(null);
    const result = await setWaiting({
      environmentId: taskRef.environmentId,
      input: { taskId: taskRef.taskId, reason: trimmed },
    });
    setPending(false);
    if (result._tag === "Success") {
      onClose();
      return;
    }
    setError(commandErrorMessage(result, "Could not update the Work Task."));
  };

  return (
    <Dialog open onOpenChange={(open) => (!open && !pending ? onClose() : undefined)}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Mark waiting for user</DialogTitle>
          <DialogDescription>
            The Work Task shows as waiting for you, with this reason, until you clear it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Input
            autoFocus
            aria-label="Reason"
            placeholder="Needs a product decision on the empty state"
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              void submit();
            }}
          />
          {error !== null ? (
            <p className="mt-2 text-destructive-foreground text-xs">{error}</p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={pending || reason.trim().length === 0}
            onClick={() => void submit()}
          >
            {pending ? <Spinner /> : null}
            Mark waiting
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
