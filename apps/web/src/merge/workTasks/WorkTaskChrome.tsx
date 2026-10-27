import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadRuntimeCanArchive } from "@t3tools/client-runtime/state/models";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { BotIcon, EllipsisIcon, GitBranchIcon, HandIcon, PlusIcon, XIcon } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { Spinner } from "~/components/ui/spinner";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { hasUnseenCompletion } from "~/components/Sidebar.logic";
import { useThreadActions } from "~/hooks/useThreadActions";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useEnvironmentScope } from "~/state/session";
import { environmentThreadShells, threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { waitForAtomValue } from "~/state/waitForAtomValue";
import { useCreateWorkTaskThread } from "./actions";
import { workTaskTabState, type WorkTaskTab, type WorkTaskView } from "./logic";
import {
  CHECKS_PRESENTATION,
  REVIEW_PRESENTATION,
  SETUP_STEP_PRESENTATION,
  TAB_STATE_PRESENTATION,
  THREAD_ORIGIN_LABEL,
  UNSEEN_RESPONSE_PRESENTATION,
  WorkTaskStatusLabel,
  type StatusPresentation,
} from "./presentation";
import { workTasksEnvironment } from "./state";
import { WORK_TASK_STATUS_PRESENTATION } from "./statusPresentation";
import { openArchiveWorkTaskDialog, openWaitingReasonDialog } from "./WorkTaskDialogs";

function errorDescription(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "An error occurred.";
}

/**
 * The Work Task bar above a task's chat: header, setup progress until ready, and one tab per
 * thread. `activeThreadId` is null on the Work Task page, whose page header names the task.
 */
export const WorkTaskChrome = memo(function WorkTaskChrome({
  view,
  activeThreadId,
}: {
  view: WorkTaskView;
  activeThreadId: ThreadId | null;
}) {
  return (
    <div className="flex shrink-0 flex-col border-b border-border bg-background">
      <WorkTaskHeader
        view={view}
        activeThreadId={activeThreadId}
        className="min-h-10 px-(--workspace-gutter-start) pt-2 pb-1.5"
      />
      {view.task.workspace.setup.status !== "ready" ? <WorkTaskSetupProgress view={view} /> : null}
      <WorkTaskTabs view={view} activeThreadId={activeThreadId} />
    </div>
  );
});

/** One row: status, title, branch, waiting chip, then PR state and the task actions. */
function WorkTaskHeader({
  view,
  activeThreadId,
  className,
}: {
  view: WorkTaskView;
  activeThreadId: ThreadId | null;
  className?: string;
}) {
  const { task, status, pullRequest } = view;
  const checks = pullRequest === null ? null : CHECKS_PRESENTATION[pullRequest.checks];
  const review = pullRequest === null ? null : REVIEW_PRESENTATION[pullRequest.review];
  const activeThreadRef: ScopedThreadRef | undefined =
    activeThreadId === null ? undefined : scopeThreadRef(task.environmentId, activeThreadId);
  const openPrLink = useOpenPrLink(activeThreadRef);
  const setWaiting = useAtomCommand(workTasksEnvironment.setWaiting, "Work Task update");
  const setAutoHandle = useAtomCommand(workTasksEnvironment.setAutoHandle, "Work Task update");
  const taskRef = { environmentId: task.environmentId, taskId: task.id };
  const canOperate = useEnvironmentScope(task.environmentId, AuthOrchestrationOperateScope);
  const archived = task.archivedAt !== null || !canOperate;
  const clearWaiting = () =>
    void setWaiting({
      environmentId: task.environmentId,
      input: { taskId: task.id, reason: null },
    });

  return (
    <div className={cn("flex min-w-0 items-center gap-3 text-xs", className)}>
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
          <WorkTaskStatusLabel status={status} compact />
        </TooltipTrigger>
        <TooltipPopup side="bottom">{WORK_TASK_STATUS_PRESENTATION[status].label}</TooltipPopup>
      </Tooltip>
      {/* The title gives way last: the branch and the waiting chip shrink first. */}
      <h2 className="min-w-12 shrink truncate font-medium text-sm">{task.title}</h2>
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
            <TooltipPopup side="bottom">{task.waitingForUserReason}</TooltipPopup>
          </Tooltip>
          <Button size="micro" variant="ghost-muted" disabled={!canOperate} onClick={clearWaiting}>
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
          render={<Button size="icon-xs" variant="ghost" aria-label="Work Task actions" />}
        >
          <EllipsisIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuCheckboxItem
            checked={task.autoHandleReviewFeedback}
            disabled={archived}
            onCheckedChange={(checked) =>
              void setAutoHandle({
                environmentId: task.environmentId,
                input: { taskId: task.id, enabled: checked },
              })
            }
          >
            Auto-handle PR feedback
          </MenuCheckboxItem>
          {task.waitingForUserReason === null ? (
            <MenuItem disabled={archived} onClick={() => openWaitingReasonDialog(taskRef)}>
              Mark waiting for user...
            </MenuItem>
          ) : (
            <MenuItem disabled={!canOperate} onClick={clearWaiting}>
              Clear waiting for user
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem
            variant="destructive"
            disabled={archived}
            onClick={() => openArchiveWorkTaskDialog(taskRef)}
          >
            Archive Work Task...
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}

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

/** The fork's setup steps, shown until setup is ready. Failed steps keep their log. */
function WorkTaskSetupProgress({ view }: { view: WorkTaskView }) {
  const { task } = view;
  const setup = task.workspace.setup;
  const retrySetup = useAtomCommand(workTasksEnvironment.retrySetup, "Work Task setup retry");
  const [retrying, setRetrying] = useState(false);
  const canOperate = useEnvironmentScope(task.environmentId, AuthOrchestrationOperateScope);
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
            disabled={retrying || task.archivedAt !== null || !canOperate}
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
          const stepGlyph = SETUP_STEP_PRESENTATION[step.status];
          return (
            <li key={step.id} className="flex flex-col gap-1">
              <span className="flex items-center gap-2">
                <span
                  role="img"
                  aria-label={stepGlyph.label}
                  className={cn("inline-flex", stepGlyph.className)}
                >
                  <stepGlyph.Icon />
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

function WorkTaskTabs({
  view,
  activeThreadId,
}: {
  view: WorkTaskView;
  activeThreadId: ThreadId | null;
}) {
  const { task, tabs } = view;
  const navigate = useNavigate();
  const { createWorkTaskThread, pending: creatingThread } = useCreateWorkTaskThread();
  const { archiveThread } = useThreadActions();
  const stopSession = useAtomCommand(threadEnvironment.stopSession, "stop thread session");
  const canOperate = useEnvironmentScope(task.environmentId, AuthOrchestrationOperateScope);
  const archived = task.archivedAt !== null || !canOperate;
  const navRef = useRef<HTMLElement>(null);

  // oxlint-disable-next-line t3code/react-effect-budget -- scrolls the open tab into the DOM viewport
  useEffect(() => {
    if (activeThreadId === null) return;
    navRef.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeThreadId]);

  // Closing a tab archives its thread (never the worktree, which the task owns); the archive's
  // undo notice brings it back. A running thread asks first and is stopped before archiving.
  // Closing the open tab first moves to its neighbor so the reader never lands outside the task.
  const closeTab = async ({ shell }: WorkTaskTab) => {
    const threadRef = scopeThreadRef(task.environmentId, shell.id);
    if (!threadRuntimeCanArchive(shell.runtime)) {
      const api = readLocalApi();
      if (!api) return;
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(
          [
            `Stop and close "${shell.title}"?`,
            "The agent is still working. Closing stops it and archives the thread.",
          ].join("\n"),
          { variant: "destructive" },
        ),
      );
      if (confirmed._tag === "Failure" || !confirmed.value) return;
      const stopped = await stopSession({
        environmentId: task.environmentId,
        input: { threadId: shell.id },
      });
      if (stopped._tag === "Failure") return;
      await waitForAtomValue({
        registry: appAtomRegistry,
        atom: environmentThreadShells.threadShellAtom(threadRef),
        predicate: (next) => next === null || threadRuntimeCanArchive(next.runtime),
        timeoutMs: 10_000,
      });
    }
    const index = tabs.findIndex((candidate) => candidate.shell.id === shell.id);
    const closingActive = shell.id === activeThreadId;
    const neighbor = closingActive ? (tabs[index + 1] ?? tabs[index - 1] ?? null) : null;
    if (neighbor !== null) {
      await navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: task.environmentId, threadId: neighbor.shell.id },
      });
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
      return;
    }
    // The last tab: archive first (it leaves the thread for a draft), then land on the task page.
    if (closingActive && neighbor === null) {
      await navigate({
        to: "/work-tasks/$environmentId/$taskId",
        params: { environmentId: task.environmentId, taskId: task.id },
      });
    }
  };

  return (
    <div className="flex min-w-0 items-end gap-1.5 px-(--workspace-gutter-start)">
      <nav
        ref={navRef}
        aria-label={`Threads in ${task.title}`}
        className="flex min-w-0 items-end gap-1 overflow-x-auto"
      >
        {tabs.map((tab) => {
          const { shell, origin } = tab;
          const tabState = workTaskTabState(shell);
          const active = shell.id === activeThreadId;
          // Live work and waiting outrank a new response; the open tab is read by definition.
          const unseen =
            !active &&
            tabState !== "running" &&
            tabState !== "monitoring" &&
            tabState !== "waiting" &&
            hasUnseenCompletion({ ...shell, lastVisitedAt: shell.lastVisitedAt });
          const state = unseen ? UNSEEN_RESPONSE_PRESENTATION : TAB_STATE_PRESENTATION[tabState];
          const automated = origin !== null && origin !== "user";
          const originLabel = automated ? THREAD_ORIGIN_LABEL[origin] : null;
          return (
            <div
              key={shell.id}
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
                      params={{ environmentId: task.environmentId, threadId: shell.id }}
                      aria-current={active ? "page" : undefined}
                      aria-label={[shell.title, state.label, originLabel]
                        .filter(Boolean)
                        .join(", ")}
                      className="flex min-w-0 items-center gap-2 py-2 outline-none focus-visible:underline"
                    />
                  }
                >
                  <state.Icon className={state.className} />
                  {automated ? <BotIcon aria-hidden className="size-3 shrink-0" /> : null}
                  <span className="min-w-0 truncate">{shell.title}</span>
                </TooltipTrigger>
                <TooltipPopup side="bottom">{shell.title}</TooltipPopup>
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
                        aria-label={`Close ${shell.title}`}
                        disabled={!canOperate}
                        onClick={() => void closeTab(tab)}
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
              aria-label="New thread in this Work Task"
              className="mb-1"
              disabled={archived || creatingThread}
              onClick={() => void createWorkTaskThread(task)}
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
