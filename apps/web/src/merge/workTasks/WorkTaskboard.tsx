import { useAtomValue } from "@effect/atom-react";
import type { WorkTaskPullRequestState } from "@t3tools/contracts";
import { ChevronDownIcon, GitBranchIcon, PlusIcon } from "lucide-react";
import { memo, useState, type MouseEvent } from "react";

import { ProviderInstanceIcon } from "~/components/chat/ProviderInstanceIcon";
import { Button } from "~/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { SidebarInset } from "~/components/ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "~/components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { isElectron } from "~/env";
import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import {
  deriveProviderEntriesByEnvironment,
  type ProviderInstanceEntry,
} from "~/providerInstances";
import { useProjects } from "~/state/entities";
import { environmentPresentations } from "~/state/presentation";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { useOpenWorkTask, useWorkTaskContextMenu } from "./actions";
import {
  groupWorkTaskboard,
  WORK_TASKBOARD_COLUMNS,
  type WorkTaskboardColumnId,
  type WorkTaskView,
} from "./logic";
import { ToneDot, WorkTaskStatusLabel } from "./presentation";
import { useWorkTaskViews } from "./state";
import { WORK_TASK_STATUS_PRESENTATION } from "./statusPresentation";
import { openNewWorkTaskDialog } from "./WorkTaskDialogs";

const BOARD_COLUMNS = WORK_TASKBOARD_COLUMNS.filter((column) => column.id !== "archive");
const NO_CARDS: ReadonlyArray<WorkTaskView> = [];

const EMPTY_COLUMN_COPY: Readonly<Record<WorkTaskboardColumnId, string>> = {
  working: "Nothing in progress",
  "needs-you": "Nothing needs you",
  "in-review": "Nothing in review",
  "ready-to-merge": "Nothing ready to merge",
  merged: "Nothing merged yet",
  archive: "Archived Work Tasks show up here.",
};

const PULL_REQUEST_STATE: Readonly<
  Record<WorkTaskPullRequestState, { label: string; className: string }>
> = {
  open: { label: "Open", className: "text-success-foreground" },
  draft: { label: "Draft", className: "text-muted-foreground" },
  closed: { label: "Closed", className: "text-destructive-foreground" },
  merged: { label: "Merged", className: "text-success-foreground" },
};

/** Every Work Task across projects and environments, one card each, by what it needs next. */
export function WorkTaskboard() {
  const views = useWorkTaskViews();
  const projects = useProjects();
  const openWorkTask = useOpenWorkTask();
  const openContextMenu = useWorkTaskContextMenu();
  const [archiveOpen, setArchiveOpen] = useState(false);
  const serverConfigs = useAtomValue(environmentPresentations.serverConfigsAtom);
  const providersByEnvironment = useAtomValue(environmentPresentations.providersByEnvironmentAtom);
  // Default instance ids are driver slugs, so lookups stay scoped per environment.
  const providerEntries = deriveProviderEntriesByEnvironment(
    [...serverConfigs].map(
      ([environmentId, config]) =>
        [environmentId, providersByEnvironment.get(environmentId) ?? [], config.settings] as const,
    ),
  );
  // Re-render relative times once a minute; nothing here animates.
  useNowMinute();

  const projectNames = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project.title]),
  );
  const columns = groupWorkTaskboard(views.values());
  const archived = columns.get("archive") ?? NO_CARDS;

  const renderCard = (view: WorkTaskView, compact = false) => (
    <li key={view.key}>
      <WorkTaskCard
        view={view}
        compact={compact}
        provider={
          view.latestThread === null
            ? undefined
            : providerEntries
                .get(view.task.environmentId)
                ?.get(view.latestThread.providerInstanceId)
        }
        projectName={
          projectNames.get(`${view.task.environmentId}:${view.task.projectId}`) ?? "Unknown project"
        }
        onOpen={openWorkTask}
        onContextMenu={openContextMenu}
      />
    </li>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <WorkspacePageHeader electron={isElectron} className="relative bg-background">
          <WorkspaceBreadcrumb ariaLabel="Work Taskboard breadcrumb">
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">Work Taskboard</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <div className="min-w-0 flex-1" />
          <Button size="sm" variant="outline" onClick={() => openNewWorkTaskDialog()}>
            <PlusIcon />
            New Work Task
          </Button>
        </WorkspacePageHeader>
        {views.size === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No Work Tasks yet</EmptyTitle>
              <EmptyDescription>
                Create a Work Task from an existing branch to track it here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <div className="grid min-h-0 flex-1 grid-cols-[repeat(5,minmax(15rem,1fr))] gap-3 overflow-x-auto p-3">
              {BOARD_COLUMNS.map((column) => {
                const cards = columns.get(column.id) ?? NO_CARDS;
                const headingId = `work-taskboard-${column.id}`;
                return (
                  <section
                    key={column.id}
                    aria-labelledby={headingId}
                    className="flex min-h-0 flex-col rounded-xl bg-muted/40"
                  >
                    <h2
                      id={headingId}
                      className="flex shrink-0 items-center gap-2 px-3 pt-3 pb-2 font-medium text-sm"
                    >
                      <ToneDot tone={column.tone} />
                      {column.label}
                      <span className="text-muted-foreground tabular-nums">{cards.length}</span>
                    </h2>
                    {cards.length === 0 ? (
                      <p className="px-3 py-6 text-center text-muted-foreground text-xs">
                        {EMPTY_COLUMN_COPY[column.id]}
                      </p>
                    ) : (
                      <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
                        {cards.map((card) => renderCard(card))}
                      </ul>
                    )}
                  </section>
                );
              })}
            </div>
            <section aria-labelledby="work-taskboard-archive" className="shrink-0 border-t">
              <h2 id="work-taskboard-archive">
                <button
                  type="button"
                  aria-expanded={archiveOpen}
                  onClick={() => setArchiveOpen((open) => !open)}
                  className="flex w-full cursor-pointer items-center gap-2 px-4 py-2 text-left font-medium text-muted-foreground text-sm hover:text-foreground"
                >
                  <ChevronDownIcon
                    aria-hidden
                    className={cn("size-3.5 shrink-0", !archiveOpen && "-rotate-90")}
                  />
                  Archive
                  <span className="tabular-nums">{archived.length}</span>
                </button>
              </h2>
              {archiveOpen ? (
                archived.length === 0 ? (
                  <p className="px-4 pb-3 text-muted-foreground text-xs">
                    {EMPTY_COLUMN_COPY.archive}
                  </p>
                ) : (
                  <ul className="grid max-h-64 grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2 overflow-y-auto px-3 pb-3">
                    {archived.map((card) => renderCard(card, true))}
                  </ul>
                )
              ) : null}
            </section>
          </>
        )}
      </div>
    </SidebarInset>
  );
}

/** One task on the board. Opens the task on click; right-click shows the task menu. */
const WorkTaskCard = memo(function WorkTaskCard({
  view,
  projectName,
  provider,
  compact,
  onOpen,
  onContextMenu,
}: {
  view: WorkTaskView;
  projectName: string;
  /** The provider driving the thread the card opens. */
  provider: ProviderInstanceEntry | undefined;
  /** Title and status only, for the archive. */
  compact: boolean;
  onOpen: (view: WorkTaskView) => void;
  onContextMenu: (view: WorkTaskView, position: { x: number; y: number }) => void;
}) {
  const { task, status, activityAt, pullRequest } = view;
  const pullRequestState = pullRequest === null ? null : PULL_REQUEST_STATE[pullRequest.state];
  return (
    <button
      type="button"
      aria-label={`${task.title}, ${WORK_TASK_STATUS_PRESENTATION[status].label}`}
      onClick={() => onOpen(view)}
      onContextMenu={(event: MouseEvent) => {
        event.preventDefault();
        onContextMenu(view, { x: event.clientX, y: event.clientY });
      }}
      className="flex w-full min-w-0 cursor-pointer flex-col gap-2 rounded-lg border bg-card p-3 text-left text-card-foreground hover:border-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
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
          <WorkTaskStatusLabel status={status} className="min-w-0" />
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
