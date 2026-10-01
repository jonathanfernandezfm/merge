import type { EnvironmentTask, TaskboardCard } from "@t3tools/client-runtime/state/tasks";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { OrchestrationTaskPullRequestState } from "@t3tools/contracts";
import { TASK_STATUS_PRESENTATION } from "@t3tools/shared/taskStatus";
import { GitBranchIcon } from "lucide-react";
import { memo, type MouseEvent } from "react";

import { cn } from "~/lib/utils";
import type { ProviderInstanceEntry } from "~/providerInstances";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { TaskStatusLabel } from "./taskPresentation";

export type TaskBoardCardData = TaskboardCard<EnvironmentTask, EnvironmentThreadShell>;

const PULL_REQUEST_STATE: Readonly<
  Record<OrchestrationTaskPullRequestState, { label: string; className: string }>
> = {
  open: { label: "Open", className: "text-success-foreground" },
  draft: { label: "Draft", className: "text-muted-foreground" },
  closed: { label: "Closed", className: "text-destructive-foreground" },
  merged: { label: "Merged", className: "text-info-foreground" },
};

/** The provider driving a thread, or undefined when its instance is unknown here. */
export function threadProviderEntry(
  thread: EnvironmentThreadShell | null,
  providerEntries: ReadonlyMap<string, ProviderInstanceEntry> | undefined,
): ProviderInstanceEntry | undefined {
  if (thread === null) return undefined;
  return providerEntries?.get(
    thread.session?.providerInstanceId ?? thread.modelSelection.instanceId,
  );
}

/** One task on the Taskboard. Opens the task on click; right-click shows the task menu. */
export const TaskBoardCard = memo(function TaskBoardCard({
  card,
  projectName,
  provider,
  compact = false,
  onOpen,
  onContextMenu,
}: {
  card: TaskBoardCardData;
  projectName: string;
  provider: ProviderInstanceEntry | undefined;
  /** Title and status only, for the archive. */
  compact?: boolean;
  onOpen: (task: EnvironmentTask, latestThread: EnvironmentThreadShell | null) => void;
  onContextMenu: (task: EnvironmentTask, position: { x: number; y: number }) => void;
}) {
  const { task, status, latestThread, activityAt } = card;
  const pullRequest = task.pullRequest;
  const pullRequestState = pullRequest === null ? null : PULL_REQUEST_STATE[pullRequest.state];
  return (
    <button
      type="button"
      aria-label={`${task.title}, ${TASK_STATUS_PRESENTATION[status].label}`}
      onClick={() => onOpen(task, latestThread)}
      onContextMenu={(event: MouseEvent) => {
        event.preventDefault();
        onContextMenu(task, { x: event.clientX, y: event.clientY });
      }}
      className="flex w-full min-w-0 cursor-pointer flex-col gap-2 rounded-lg border bg-card p-3 text-left text-card-foreground hover:border-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex min-w-0 items-start gap-2">
        {provider !== undefined ? (
          <ProviderInstanceIcon
            driverKind={provider.driverKind}
            displayName={provider.displayName}
            className="mt-0.5"
            iconClassName="size-4"
          />
        ) : null}
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-muted-foreground text-xs">{projectName}</span>
          <span className="line-clamp-2 font-medium text-sm">{task.title}</span>
        </span>
      </span>
      {compact ? null : (
        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
          <GitBranchIcon aria-hidden className="size-3 shrink-0" />
          <span className="sr-only">Branch</span>
          <span className="truncate font-mono">{task.workspace.branch}</span>
        </span>
      )}
      <span className="flex min-w-0 flex-col gap-1.5 border-t pt-2">
        <span className="flex min-w-0 items-center gap-2">
          <TaskStatusLabel status={status} className="min-w-0" />
          <time
            dateTime={activityAt}
            className="ms-auto shrink-0 text-muted-foreground text-xs tabular-nums"
          >
            {formatRelativeTimeLabel(activityAt)}
          </time>
        </span>
        {pullRequest !== null && pullRequestState !== null && !compact ? (
          <span className="flex min-w-0 items-center gap-1.5 font-mono text-xs">
            <span className="text-muted-foreground">PR #{pullRequest.number}</span>
            <span aria-hidden className="text-muted-foreground/60">
              ·
            </span>
            <span className={cn("shrink-0", pullRequestState.className)}>
              {pullRequestState.label}
            </span>
          </span>
        ) : null}
      </span>
    </button>
  );
});
