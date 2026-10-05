import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  isAutomatedThreadOrigin,
  resolveTaskStatus,
  taskThreadTabState,
  type EnvironmentTask,
} from "@t3tools/client-runtime/state/tasks";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { TASK_STATUS_PRESENTATION } from "@t3tools/shared/taskStatus";
import { Link, useNavigate } from "@tanstack/react-router";
import { BotIcon, EllipsisIcon, GitBranchIcon, HandIcon, PlusIcon, XIcon } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import { useThreadActions } from "~/hooks/useThreadActions";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { useThreadShell, waitForThreadShell } from "~/state/entities";
import { taskEnvironment, useTask, useTaskThreadShells } from "~/state/tasks";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { openArchiveTaskDialog, openWaitingReasonDialog } from "./TaskDialogs";
import {
  CHECKS_PRESENTATION,
  REVIEW_PRESENTATION,
  SETUP_STEP_PRESENTATION,
  TASK_THREAD_TAB_STATE_PRESENTATION,
  TaskStatusLabel,
  THREAD_ORIGIN_LABEL,
  UNSEEN_RESPONSE_PRESENTATION,
  type StatusPresentation,
} from "./taskPresentation";
import { useUnseenThreadFlags } from "./useUnseenThreads";

function errorDescription(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "An error occurred.";
}

/** The task a thread belongs to, or null for threads outside a task and drafts. */
export function useThreadTask(threadRef: ScopedThreadRef | null): EnvironmentTask | null {
  const thread = useThreadShell(threadRef);
  return useTask(threadRef?.environmentId ?? null, thread?.taskId ?? null);
}

/**
 * Task header, setup progress, and thread tabs; `activeThreadId` is null on
 * the task page. `showTitle` is off where the page header already names the task.
 * `showHeader` is off where the page header renders `TaskHeader` itself.
 */
export const TaskWorkspaceChrome = memo(function TaskWorkspaceChrome({
  task,
  activeThreadId,
  showTitle = true,
  showHeader = true,
}: {
  task: EnvironmentTask;
  activeThreadId: ThreadId | null;
  showTitle?: boolean;
  showHeader?: boolean;
}) {
  const threads = useTaskThreadShells({ environmentId: task.environmentId, taskId: task.id });
  return (
    <div
      className={cn(
        "flex shrink-0 flex-col border-b border-border bg-background",
        !showHeader && "pt-2",
      )}
    >
      {showHeader ? (
        <TaskHeader
          task={task}
          activeThreadId={activeThreadId}
          showTitle={showTitle}
          className="min-h-11 px-(--workspace-gutter-start) pt-2.5 pb-2"
        />
      ) : null}
      {task.workspace.setup.status !== "ready" ? <TaskSetupProgress task={task} /> : null}
      <TaskThreadTabs task={task} threads={threads} activeThreadId={activeThreadId} />
    </div>
  );
});

/** One row: status, title, branch, waiting chip, then PR state and the task actions. */
export const TaskHeader = memo(function TaskHeader({
  task,
  activeThreadId,
  showTitle = true,
  className,
}: {
  task: EnvironmentTask;
  activeThreadId: ThreadId | null;
  showTitle?: boolean;
  className?: string;
}) {
  const threads = useTaskThreadShells({ environmentId: task.environmentId, taskId: task.id });
  const status = resolveTaskStatus(task, threads);
  const pullRequest = task.pullRequest;
  const checks = pullRequest === null ? null : CHECKS_PRESENTATION[pullRequest.checks];
  const review = pullRequest === null ? null : REVIEW_PRESENTATION[pullRequest.review];
  const activeThreadRef: ScopedThreadRef | undefined =
    activeThreadId === null ? undefined : scopeThreadRef(task.environmentId, activeThreadId);
  const openPrLink = useOpenPrLink(activeThreadRef);
  const updateTask = useAtomCommand(taskEnvironment.updateMetadata, "task update");
  const taskRef = { environmentId: task.environmentId, taskId: task.id };
  const archived = task.archivedAt !== null;
  const clearWaiting = () =>
    void updateTask({
      environmentId: task.environmentId,
      input: { taskId: task.id, waitingForUserReason: null },
    });

  return (
    <div className={cn("flex min-w-0 items-center gap-3 text-xs", className)}>
      {showTitle ? (
        // Next to the title the status shrinks to its glyph so the title leads.
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
            <TaskStatusLabel status={status} compact />
          </TooltipTrigger>
          <TooltipPopup side="bottom">{TASK_STATUS_PRESENTATION[status].label}</TooltipPopup>
        </Tooltip>
      ) : (
        <TaskStatusLabel status={status} className="shrink-0" />
      )}
      {showTitle ? (
        // The title gives way last: the branch and the waiting chip shrink first.
        <h2 className="min-w-12 shrink truncate font-medium text-sm">{task.title}</h2>
      ) : null}
      <span className="flex min-w-0 shrink-[4] items-center gap-1.5 text-muted-foreground">
        <GitBranchIcon aria-hidden className="size-3 shrink-0" />
        <span className="sr-only">Branch</span>
        <span className="truncate">{task.workspace.branch}</span>
      </span>
      {task.waitingForUserReason !== null ? (
        <span className="flex min-w-0 shrink-[4] items-center gap-1 text-warning-foreground">
          <Tooltip>
            <TooltipTrigger render={<span className="flex min-w-0 items-center gap-1" />}>
              <HandIcon aria-hidden className="size-3 shrink-0" />
              <span className="truncate">Waiting for you: {task.waitingForUserReason}</span>
            </TooltipTrigger>
            <TooltipPopup side="bottom" className="max-w-80">
              {task.waitingForUserReason}
            </TooltipPopup>
          </Tooltip>
          <Button size="micro" variant="ghost-muted" className="shrink-0" onClick={clearWaiting}>
            Clear
          </Button>
        </span>
      ) : null}
      <div className="min-w-0 flex-1" />
      {pullRequest !== null ? (
        <span className="flex shrink-0 items-center gap-2.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <a
                  href={pullRequest.url}
                  className="font-medium text-foreground hover:underline"
                  onClick={(event) => openPrLink(event, pullRequest.url, activeThreadRef)}
                />
              }
            >
              PR #{pullRequest.number}
            </TooltipTrigger>
            <TooltipPopup side="bottom">{pullRequest.title}</TooltipPopup>
          </Tooltip>
          {checks !== null ? <StateGlyph {...checks} /> : null}
          {review !== null ? <StateGlyph {...review} /> : null}
        </span>
      ) : null}
      <Menu>
        <MenuTrigger
          render={
            <Button size="icon-xs" variant="ghost" className="shrink-0" aria-label="Task actions" />
          }
        >
          <EllipsisIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuCheckboxItem
            checked={task.autoHandleReviewFeedback}
            disabled={archived}
            onCheckedChange={(checked) =>
              void updateTask({
                environmentId: task.environmentId,
                input: { taskId: task.id, autoHandleReviewFeedback: checked },
              })
            }
          >
            Auto-handle review feedback
          </MenuCheckboxItem>
          {task.waitingForUserReason === null ? (
            <MenuItem disabled={archived} onClick={() => openWaitingReasonDialog(taskRef)}>
              Mark waiting for user...
            </MenuItem>
          ) : (
            <MenuItem onClick={clearWaiting}>Clear waiting for user</MenuItem>
          )}
          <MenuSeparator />
          <MenuItem
            variant="destructive"
            disabled={archived}
            onClick={() => openArchiveTaskDialog(taskRef)}
          >
            Archive task...
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
});

function StateGlyph({ label, Icon, className }: StatusPresentation) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span role="img" aria-label={label} className={cn("inline-flex", className)} />}
      >
        <Icon />
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** The workspace setup steps, shown until setup is ready. Failed steps keep their log. */
function TaskSetupProgress({ task }: { task: EnvironmentTask }) {
  const setup = task.workspace.setup;
  const retrySetup = useAtomCommand(taskEnvironment.retrySetup, "task setup retry");
  const [retrying, setRetrying] = useState(false);
  const failed = setup.status === "failed";
  return (
    <div className="flex flex-col gap-2 px-(--workspace-gutter-start) pb-3 text-xs">
      <div className="flex items-center gap-2">
        <span
          className={cn("font-medium", failed ? "text-destructive-foreground" : "text-foreground")}
        >
          {failed ? "Workspace setup failed" : "Setting up the workspace"}
        </span>
        {failed ? (
          <Button
            size="micro"
            variant="outline"
            disabled={retrying || task.archivedAt !== null}
            onClick={() => {
              setRetrying(true);
              void retrySetup({
                environmentId: task.environmentId,
                input: { taskId: task.id },
              }).finally(() => setRetrying(false));
            }}
          >
            Retry setup
          </Button>
        ) : null}
      </div>
      {setup.error !== null && setup.steps.every((step) => step.status !== "failed") ? (
        <p className="text-destructive-foreground">{setup.error}</p>
      ) : null}
      <ol className="flex flex-col gap-1">
        {setup.steps.map((step) => {
          const glyph = SETUP_STEP_PRESENTATION[step.status];
          return (
            <li key={step.id} className="flex flex-col gap-1">
              <span className="flex items-center gap-2">
                <span
                  role="img"
                  aria-label={glyph.label}
                  className={cn("inline-flex", glyph.className)}
                >
                  <glyph.Icon />
                </span>
                <span className="min-w-0 truncate">{step.label}</span>
              </span>
              {step.status === "failed" && step.log ? (
                <details className="ms-5">
                  <summary className="cursor-pointer text-muted-foreground">Show log</summary>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-muted-foreground">
                    {step.log}
                  </pre>
                </details>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * Creates a thread in a task and opens it. A call while one is in flight is a
 * no-op, so a double click never makes two threads.
 */
export function useCreateTaskThread() {
  const navigate = useNavigate();
  const createThread = useAtomCommand(taskEnvironment.createThread, "new task thread");
  const inFlightRef = useRef(false);
  const [pending, setPending] = useState(false);
  const createTaskThread = useCallback(
    async (task: Pick<EnvironmentTask, "environmentId" | "id">) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      setPending(true);
      try {
        const result = await createThread({
          environmentId: task.environmentId,
          input: { taskId: task.id },
        });
        if (result._tag !== "Success") return;
        const threadRef = { environmentId: task.environmentId, threadId: result.value.threadId };
        await waitForThreadShell(threadRef).catch(() => undefined);
        await navigate({ to: "/$environmentId/$threadId", params: threadRef });
      } finally {
        inFlightRef.current = false;
        setPending(false);
      }
    },
    [createThread, navigate],
  );
  return { createTaskThread, pending };
}

/** The archive guard in `useThreadActions`: a turn is still in progress. */
function hasActiveTurn(thread: EnvironmentThreadShell): boolean {
  return thread.session?.status === "running" && thread.session.activeTurnId != null;
}

function TaskThreadTabs({
  task,
  threads,
  activeThreadId,
}: {
  task: EnvironmentTask;
  threads: ReadonlyArray<EnvironmentThreadShell>;
  activeThreadId: ThreadId | null;
}) {
  const navigate = useNavigate();
  const { createTaskThread, pending: creatingThread } = useCreateTaskThread();
  const { archiveThread } = useThreadActions();
  const stopSession = useAtomCommand(threadEnvironment.stopSession, "stop thread session");
  const archived = task.archivedAt !== null;
  const navRef = useRef<HTMLElement>(null);
  const unseenFlags = useUnseenThreadFlags(threads);

  useEffect(() => {
    if (activeThreadId === null) return;
    navRef.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeThreadId]);

  // Closing a tab archives its thread (never the worktree, which the task
  // owns); the archive's undo notice brings it back. A running thread asks
  // first and is stopped before it is archived. Closing the open tab first
  // moves to its neighbor so the archive never drops the reader onto a draft
  // outside the task.
  const closeTab = async (thread: EnvironmentThreadShell) => {
    const threadRef = scopeThreadRef(task.environmentId, thread.id);
    if (taskThreadTabState(thread) === "running") {
      const api = readLocalApi();
      if (!api) return;
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(
          [
            `Stop and close "${thread.title}"?`,
            "The agent is still working. Closing stops it and archives the thread.",
          ].join("\n"),
          { variant: "destructive" },
        ),
      );
      if (confirmed._tag === "Failure" || !confirmed.value) return;
      const stopped = await stopSession({
        environmentId: task.environmentId,
        input: { threadId: thread.id },
      });
      if (stopped._tag === "Failure") return;
      // The archive refuses a thread whose turn is still in progress.
      await waitForThreadShell(threadRef, 10_000, (shell) => !hasActiveTurn(shell)).catch(
        () => undefined,
      );
    }
    const index = threads.findIndex((candidate) => candidate.id === thread.id);
    if (thread.id === activeThreadId) {
      const neighbor = threads[index + 1] ?? threads[index - 1] ?? null;
      await (neighbor !== null
        ? navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId: task.environmentId, threadId: neighbor.id },
          })
        : navigate({
            to: "/tasks/$environmentId/$taskId",
            params: { environmentId: task.environmentId, taskId: task.id },
          }));
    }
    const result = await archiveThread(threadRef);
    if (result._tag === "Failure") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not close the thread",
          description: errorDescription(squashAtomCommandFailure(result)),
        }),
      );
    }
  };

  return (
    <div className="flex min-w-0 items-end gap-1.5 px-(--workspace-gutter-start)">
      <nav
        ref={navRef}
        aria-label={`Threads in ${task.title}`}
        className="flex min-w-0 items-end gap-1 overflow-x-auto"
      >
        {threads.map((thread, index) => {
          const tabState = taskThreadTabState(thread);
          const active = thread.id === activeThreadId;
          // Live work and waiting outrank a new response; the open tab is read by definition.
          const unseen =
            !active &&
            unseenFlags[index] === true &&
            tabState !== "running" &&
            tabState !== "monitoring" &&
            tabState !== "waiting";
          const state = unseen
            ? UNSEEN_RESPONSE_PRESENTATION
            : TASK_THREAD_TAB_STATE_PRESENTATION[tabState];
          const automated = isAutomatedThreadOrigin(thread.origin);
          const originLabel =
            automated && thread.origin ? THREAD_ORIGIN_LABEL[thread.origin] : null;
          return (
            <div
              key={thread.id}
              className={cn(
                "group flex max-w-60 shrink-0 items-center gap-1.5 rounded-t-lg border border-b-0 ps-3 pe-1.5 text-xs",
                active
                  ? "border-border bg-muted text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                unseen && "font-semibold text-foreground",
              )}
            >
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Link
                      to="/$environmentId/$threadId"
                      params={{ environmentId: task.environmentId, threadId: thread.id }}
                      aria-current={active ? "page" : undefined}
                      aria-label={[thread.title, state.label, originLabel]
                        .filter(Boolean)
                        .join(", ")}
                      className="flex min-w-0 items-center gap-2 py-2 outline-none focus-visible:underline"
                    />
                  }
                >
                  <state.Icon className={state.className} />
                  {automated ? <BotIcon aria-hidden className="size-3 shrink-0" /> : null}
                  <span className="min-w-0 truncate">{thread.title}</span>
                </TooltipTrigger>
                <TooltipPopup side="bottom">{thread.title}</TooltipPopup>
              </Tooltip>
              <span
                className={cn(
                  "flex",
                  !active && "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100",
                )}
              >
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-tiny"
                        variant="ghost-muted"
                        aria-label={`Close ${thread.title}`}
                        onClick={() => void closeTab(thread)}
                      />
                    }
                  >
                    <XIcon />
                  </TooltipTrigger>
                  <TooltipPopup side="bottom">Close (archives the thread)</TooltipPopup>
                </Tooltip>
              </span>
            </div>
          );
        })}
      </nav>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="New thread in this task"
              className="mb-1 shrink-0"
              disabled={archived || creatingThread}
              onClick={() => void createTaskThread(task)}
            />
          }
        >
          {creatingThread ? <Spinner /> : <PlusIcon />}
        </TooltipTrigger>
        <TooltipPopup side="bottom">New thread</TooltipPopup>
      </Tooltip>
    </div>
  );
}
