import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedTaskRef } from "@t3tools/client-runtime/state/tasks";
import {
  type EnvironmentId,
  type ProjectId,
  type TaskArchiveBlocker,
  type TaskCreateResult,
  TaskOperationError,
  type VcsRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";
import { GitBranchIcon } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useProjects, waitForThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { taskEnvironment, useTask } from "~/state/tasks";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "../ui/combobox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { taskTitleFromBranch } from "./taskTitleFromBranch";

interface NewTaskDialogTarget {
  readonly environmentId?: EnvironmentId;
  readonly projectId?: ProjectId;
}

/**
 * Which task dialog is open. Set by whichever entry point asked (sidebar,
 * command palette, task header) and rendered once by the chat layout, so a
 * dialog outlives the palette or menu that opened it.
 */
const newTaskDialogAtom = Atom.make<NewTaskDialogTarget | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("tasks:new-task-dialog"),
);
const archiveTaskDialogAtom = Atom.make<ScopedTaskRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("tasks:archive-dialog"),
);
const waitingReasonDialogAtom = Atom.make<ScopedTaskRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("tasks:waiting-reason-dialog"),
);

export function openNewTaskDialog(target: NewTaskDialogTarget = {}): void {
  appAtomRegistry.set(newTaskDialogAtom, target);
}

export function openArchiveTaskDialog(ref: ScopedTaskRef): void {
  appAtomRegistry.set(archiveTaskDialogAtom, ref);
}

export function openWaitingReasonDialog(ref: ScopedTaskRef): void {
  appAtomRegistry.set(waitingReasonDialogAtom, ref);
}

const isTaskOperationError = Schema.is(TaskOperationError);

function commandErrorMessage(result: AtomCommandResult<unknown, unknown>, fallback: string) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

/** Mounted once by the chat layout. */
export function TaskDialogsHost() {
  const newTaskTarget = useAtomValue(newTaskDialogAtom);
  const archiveTarget = useAtomValue(archiveTaskDialogAtom);
  const waitingTarget = useAtomValue(waitingReasonDialogAtom);
  return (
    <>
      {newTaskTarget !== null ? (
        <NewTaskDialog
          target={newTaskTarget}
          onClose={() => appAtomRegistry.set(newTaskDialogAtom, null)}
        />
      ) : null}
      {archiveTarget !== null ? (
        <ArchiveTaskDialog
          taskRef={archiveTarget}
          onClose={() => appAtomRegistry.set(archiveTaskDialogAtom, null)}
        />
      ) : null}
      {waitingTarget !== null ? (
        <WaitingReasonDialog
          taskRef={waitingTarget}
          onClose={() => appAtomRegistry.set(waitingReasonDialogAtom, null)}
        />
      ) : null}
    </>
  );
}

/** Navigates to a task's new thread, or to the task itself when it has none yet. */
function useOpenCreatedTask() {
  const navigate = useNavigate();
  return useCallback(
    async (environmentId: EnvironmentId, result: TaskCreateResult) => {
      if (result.threadId !== undefined) {
        const threadRef = { environmentId, threadId: result.threadId };
        // The RPC returns before the shell event lands; opening the route
        // early would briefly render a missing thread.
        await waitForThreadShell(threadRef).catch(() => undefined);
        await navigate({ to: "/$environmentId/$threadId", params: threadRef });
        return;
      }
      await navigate({
        to: "/tasks/$environmentId/$taskId",
        params: { environmentId, taskId: result.taskId },
      });
    },
    [navigate],
  );
}

const REF_LIMIT = 100;

/** `remoteName` is absent for a local branch; the server uses the project's default remote. */
type BranchChoice = { remoteName?: string; branch: string };

/** A remote ref as the task picker offers it: `origin/feature` checks out `feature`. */
function remoteBranchOf(ref: VcsRef): { remoteName: string; branch: string } | null {
  if (!ref.isRemote || !ref.remoteName) return null;
  const prefix = `${ref.remoteName}/`;
  if (!ref.name.startsWith(prefix)) return null;
  const branch = ref.name.slice(prefix.length);
  return branch.length === 0 || branch === "HEAD" ? null : { remoteName: ref.remoteName, branch };
}

function NewTaskDialog({ target, onClose }: { target: NewTaskDialogTarget; onClose: () => void }) {
  const projects = useProjects();
  const formId = useId();
  const [projectKey, setProjectKey] = useState<string | null>(() => {
    const initial =
      projects.find(
        (project) =>
          project.environmentId === target.environmentId && project.id === target.projectId,
      ) ?? (projects.length === 1 ? projects[0] : undefined);
    return initial ? `${initial.environmentId}:${initial.id}` : null;
  });
  const project = useMemo(
    () =>
      projects.find((candidate) => `${candidate.environmentId}:${candidate.id}` === projectKey) ??
      null,
    [projectKey, projects],
  );
  const projectItems = useMemo(
    () =>
      projects.map((candidate) => ({
        value: `${candidate.environmentId}:${candidate.id}`,
        label: candidate.title,
      })),
    [projects],
  );
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
  const createTask = useAtomCommand(taskEnvironment.create, { reportFailure: false });
  const openCreatedTask = useOpenCreatedTask();

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(branchQuery.trim()), 200);
    return () => window.clearTimeout(timeout);
  }, [branchQuery]);

  // Only the unfiltered list fetches from the remote; typing filters what
  // that fetch brought in instead of fetching on every keystroke.
  const query =
    selectedRefName !== null && debouncedQuery === selectedRefName ? "" : debouncedQuery;
  // Local branches list without a refresh, so they show while remotes load.
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
      : vcsEnvironment.listRefs({
          environmentId: project.environmentId,
          input: {
            cwd: project.workspaceRoot,
            refKind: "remote",
            // A remote branch is still a valid task source when a local branch
            // of the same name exists (e.g. left behind by an archived task).
            includeMatchingRemoteRefs: true,
            limit: REF_LIMIT,
            ...(query.length > 0 ? { query } : { refresh: true }),
          },
        }),
  );
  const branchChoices = useMemo(
    () =>
      new Map<string, BranchChoice>([
        ...(localRefs.data?.refs ?? []).flatMap((ref) =>
          ref.isRemote ? [] : [[ref.name, { branch: ref.name }] as const],
        ),
        ...(remoteRefs.data?.refs ?? []).flatMap((ref) => {
          const remote = remoteBranchOf(ref);
          return remote === null ? [] : [[ref.name, remote] as const];
        }),
      ]),
    [localRefs.data, remoteRefs.data],
  );
  const refsPending = localRefs.isPending || remoteRefs.isPending;
  const refsError = localRefs.error ?? remoteRefs.error;
  // Kept apart from the list so a later filtered fetch cannot drop the choice.
  const [chosenBranch, setChosenBranch] = useState<BranchChoice | null>(null);
  const chooseBranch = (choice: BranchChoice | null) => {
    setChosenBranch(choice);
    setHeldAt(null);
    if (!titleEdited) setTitle(choice === null ? "" : taskTitleFromBranch(choice.branch));
  };

  const canSubmit =
    !pending && project !== null && title.trim().length > 0 && chosenBranch !== null;

  const submit = async (detachCheckoutAt?: string) => {
    if (!canSubmit || project === null || chosenBranch === null) return;
    setPending(true);
    setError(null);
    setHeldAt(null);
    const result = await createTask({
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
        isTaskOperationError(failure) &&
        failure.reason === "branch-checked-out" &&
        failure.checkoutPath !== undefined
      ) {
        setHeldAt({ branch: chosenBranch.branch, path: failure.checkoutPath });
        return;
      }
      setError(commandErrorMessage(result, "Could not create the task."));
      return;
    }
    onClose();
    await openCreatedTask(project.environmentId, result.value);
  };

  return (
    <Dialog open onOpenChange={(open) => (!open && !pending ? onClose() : undefined)}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>
            A task works on an existing branch in its own worktree. It checks the branch out and
            never creates one.
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
              <Label htmlFor={`${formId}-title`}>Title</Label>
              <Input
                id={`${formId}-title`}
                autoFocus
                placeholder="ABC-123 Permissions"
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                  setTitleEdited(event.target.value.trim().length > 0);
                }}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-branch`}>Branch</Label>
              <Combobox
                items={[...branchChoices.keys()]}
                value={selectedRefName}
                onValueChange={(value) => {
                  setSelectedRefName(value);
                  chooseBranch(value === null ? null : (branchChoices.get(value) ?? null));
                  if (value !== null) setBranchQuery(value);
                }}
                inputValue={branchQuery}
                onInputValueChange={(value) => {
                  setBranchQuery(value);
                  // Typing past a selection drops it, so submit never uses a
                  // branch other than the one the field shows.
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
            {error !== null ? <p className="text-destructive text-xs">{error}</p> : null}
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} size="sm" disabled={!canSubmit}>
            {pending ? <Spinner /> : null}
            {pending ? "Creating..." : "Create task"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

const ARCHIVE_BLOCKER_COPY: Readonly<Record<TaskArchiveBlocker, string>> = {
  "uncommitted-changes": "The workspace has uncommitted changes. They will be lost.",
  "unpushed-commits": "Some commits were never pushed. They will be lost.",
  "pull-request-open": "The pull request is still open.",
  "agent-running": "An agent is still running. It will be stopped.",
};

function ArchiveTaskDialog({ taskRef, onClose }: { taskRef: ScopedTaskRef; onClose: () => void }) {
  const task = useTask(taskRef.environmentId, taskRef.taskId);
  const navigate = useNavigate();
  const archiveCheck = useAtomCommand(taskEnvironment.archiveCheck, { reportFailure: false });
  const archiveTask = useAtomCommand(taskEnvironment.archive, { reportFailure: false });
  const [blockers, setBlockers] = useState<ReadonlyArray<TaskArchiveBlocker> | null>(null);
  const [checking, setChecking] = useState(true);
  const [checkError, setCheckError] = useState<string | null>(null);
  // Only the latest check may settle the dialog; unmounting invalidates it too.
  const checkIdRef = useRef(0);

  const runCheck = useCallback(async () => {
    const checkId = ++checkIdRef.current;
    const result = await archiveCheck({
      environmentId: taskRef.environmentId,
      input: { taskId: taskRef.taskId },
    });
    if (checkId !== checkIdRef.current) return;
    setChecking(false);
    if (result._tag === "Success") {
      setBlockers(result.value.blockers);
      return;
    }
    setCheckError(
      commandErrorMessage(result, "Could not check the workspace.") ??
        "Could not check the workspace.",
    );
  }, [archiveCheck, taskRef.environmentId, taskRef.taskId]);

  useEffect(() => {
    void runCheck();
    return () => {
      checkIdRef.current += 1;
    };
  }, [runCheck]);

  const retryCheck = () => {
    setChecking(true);
    setCheckError(null);
    void runCheck();
  };

  // Archiving removes the worktree and can take a while, so the dialog closes
  // right away and a toast tracks the outcome. The command runs through the
  // atom registry, so it survives this dialog unmounting.
  const confirm = async () => {
    if (blockers === null) return;
    const title = task?.title ?? "task";
    onClose();
    // The open thread now belongs to an archived task and can no longer run
    // turns. The Taskboard lists archived tasks; the task route would race the
    // thread.archived shell events and redirect back to the stale thread.
    void navigate({ to: "/taskboard" });
    const toastId = toastManager.add({
      type: "loading",
      title: `Archiving ${title}...`,
      timeout: 0,
    });
    const result = await archiveTask({
      environmentId: taskRef.environmentId,
      input: {
        taskId: taskRef.taskId,
        ...(blockers.length > 0 ? { force: true } : {}),
      },
    });
    if (result._tag === "Success") {
      toastManager.update(toastId, { type: "success", title: `Archived ${title}`, timeout: 4000 });
      return;
    }
    // A blocker can appear between the check and the archive (an agent
    // started); offer to review it instead of archiving anyway.
    toastManager.update(toastId, {
      type: "error",
      title: `Could not archive ${title}`,
      description: commandErrorMessage(result, "Could not archive the task."),
      timeout: 0,
      actionProps: {
        children: "Review",
        onClick: () => openArchiveTaskDialog(taskRef),
      },
    });
  };

  const hasBlockers = blockers !== null && blockers.length > 0;
  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Archive {task?.title ?? "task"}?</DialogTitle>
          <DialogDescription>
            Archiving stops the task's agents and removes its worktree. The remote branch is kept,
            and the task's threads and pull request stay in its history.
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
              <p className="min-w-0 flex-1 text-destructive text-xs">{checkError}</p>
              <Button type="button" size="xs" variant="outline" onClick={retryCheck}>
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
            {hasBlockers ? "Archive anyway" : "Archive task"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function WaitingReasonDialog({
  taskRef,
  onClose,
}: {
  taskRef: ScopedTaskRef;
  onClose: () => void;
}) {
  const task = useTask(taskRef.environmentId, taskRef.taskId);
  const updateTask = useAtomCommand(taskEnvironment.updateMetadata, { reportFailure: false });
  const [reason, setReason] = useState(task?.waitingForUserReason ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = reason.trim();
    if (pending || trimmed.length === 0) return;
    setPending(true);
    setError(null);
    const result = await updateTask({
      environmentId: taskRef.environmentId,
      input: { taskId: taskRef.taskId, waitingForUserReason: trimmed },
    });
    setPending(false);
    if (result._tag === "Success") {
      onClose();
      return;
    }
    setError(commandErrorMessage(result, "Could not update the task."));
  };

  return (
    <Dialog open onOpenChange={(open) => (!open && !pending ? onClose() : undefined)}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Mark waiting for user</DialogTitle>
          <DialogDescription>
            The task shows as waiting for you, with this reason, until you clear it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Input
            autoFocus
            aria-label="Reason"
            placeholder="Needs a product decision on the empty state"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              void submit();
            }}
          />
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
