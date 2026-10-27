import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { selectRunningSubprocessTerminalIds } from "@t3tools/client-runtime/state/terminal";
import type { EnvironmentId, ThreadId, WorkTaskId } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  ChevronDownIcon,
  FolderClosedIcon,
  FolderOpenIcon,
  Link2Icon,
  ListFilterIcon,
  PlusIcon,
  SquareKanbanIcon,
  TerminalIcon,
} from "lucide-react";
import { memo, useState, type MouseEvent } from "react";

import { hasUnseenCompletion } from "~/components/Sidebar.logic";
import { SidebarHeaderIconButton } from "~/components/sidebar/SidebarThreadHeader";
import { terminalStatusFromRunningIds } from "~/components/ThreadStatusIndicators";
import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { SidebarGroup, useSidebar } from "~/components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { useProjects } from "~/state/entities";
import { useKnownTerminalSessions } from "~/state/terminalSessions";
import { useOpenWorkTask, useWorkTaskContextMenu } from "./actions";
import {
  groupSidebarWorkTasks,
  WORK_TASK_SORTS,
  workTaskKey,
  type WorkTaskProjectGroup,
  type WorkTaskSort,
  type WorkTaskView,
} from "./logic";
import { UNSEEN_RESPONSE_PRESENTATION, WorkTaskStatusIcon } from "./presentation";
import { useLinkedWorkTasks, useThreadWorkTask, useWorkTaskViews } from "./state";
import { WORK_TASK_STATUS_PRESENTATION } from "./statusPresentation";
import { openNewWorkTaskDialog } from "./WorkTaskDialogs";

const EXPANDED_KEY = "merge:work-tasks:expanded";
const PROJECTS_EXPANDED_KEY = "merge:work-tasks:projects-expanded";
const HIDDEN_PROJECTS_KEY = "merge:work-tasks:projects-hidden";
const SORT_KEY = "merge:work-tasks:sort";
const ProjectsExpandedSchema = Schema.Record(Schema.String, Schema.Boolean);
const HiddenProjectsSchema = Schema.Array(Schema.String);
const SortSchema = Schema.Literals(WORK_TASK_SORTS.map((sort) => sort.value));
const NO_HIDDEN_PROJECTS: ReadonlyArray<string> = [];

function isWorkTaskSort(value: unknown): value is WorkTaskSort {
  return WORK_TASK_SORTS.some((sort) => sort.value === value);
}

/** The task the current route shows, from one of its threads or the Work Task page. */
function useActiveWorkTaskKey(): string | null {
  const params = useParams({
    strict: false,
    select: (value) => ({
      environmentId: value.environmentId as EnvironmentId | undefined,
      threadId: "threadId" in value ? (value.threadId as ThreadId | undefined) : undefined,
      taskId: "taskId" in value ? (value.taskId as WorkTaskId | undefined) : undefined,
    }),
  });
  const threadTask = useThreadWorkTask(
    params.environmentId && params.threadId
      ? scopeThreadRef(params.environmentId, params.threadId)
      : null,
  );
  if (!params.environmentId) return null;
  if (params.taskId) return workTaskKey(params.environmentId, params.taskId);
  return threadTask?.key ?? null;
}

/**
 * Every project with its active Work Tasks; projects without tasks start collapsed. The header
 * menu hides projects and orders tasks; search still reaches hidden projects. Renders nothing
 * when nothing is left to show; the Work Taskboard stays reachable from the command palette.
 */
export const SidebarWorkTasks = memo(function SidebarWorkTasks({
  searchQuery = "",
}: {
  searchQuery?: string;
}) {
  const views = useWorkTaskViews();
  const projects = useProjects();
  const linkedByKey = useLinkedWorkTasks();
  // Hovering a linked task highlights the same branch in the other repositories.
  const [hoveredBranch, setHoveredBranch] = useState<string | null>(null);
  const activeKey = useActiveWorkTaskKey();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const [storedExpanded, setExpanded] = useLocalStorage(EXPANDED_KEY, true, Schema.Boolean);
  const searching = searchQuery.trim().length > 0;
  // Matches would hide behind a collapsed section.
  const expanded = searching || storedExpanded;
  const [hiddenProjects, setHiddenProjects] = useLocalStorage(
    HIDDEN_PROJECTS_KEY,
    NO_HIDDEN_PROJECTS,
    HiddenProjectsSchema,
  );
  const [sort, setSort] = useLocalStorage<WorkTaskSort, WorkTaskSort>(
    SORT_KEY,
    "newest",
    SortSchema,
  );
  const hiddenProjectKeys = new Set(hiddenProjects);
  const setProjectHidden = (key: string, hidden: boolean) =>
    setHiddenProjects((value) =>
      hidden ? [...value.filter((entry) => entry !== key), key] : value.filter((e) => e !== key),
    );
  // Only projects that still exist count, so stale keys never keep the section alive.
  const hiddenCount = projects.filter((project) =>
    hiddenProjectKeys.has(`${project.environmentId}:${project.id}`),
  ).length;

  const groups = groupSidebarWorkTasks({
    views: views.values(),
    projects,
    hiddenProjectKeys,
    query: searchQuery,
    sort,
  });
  const projectTitles = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project.title]),
  );

  // Explicit toggles per project; untouched projects open only when they have tasks.
  const [projectExpanded, setProjectExpanded] = useLocalStorage(
    PROJECTS_EXPANDED_KEY,
    {},
    ProjectsExpandedSchema,
  );
  const isProjectExpanded = (group: WorkTaskProjectGroup) =>
    searching || (projectExpanded[group.key] ?? group.views.length > 0);

  const closeMobileSidebar = () => {
    if (isMobile) setOpenMobile(false);
  };
  const openWorkTask = useOpenWorkTask();
  const openContextMenu = useWorkTaskContextMenu(closeMobileSidebar);

  // Keep the header while projects are hidden; it holds the way back.
  if (groups.length === 0 && (searching || hiddenCount === 0)) return null;

  return (
    <SidebarGroup className="shrink-0">
      <div className="group/work-tasks-header flex h-8 items-center gap-1 ps-2">
        <button
          type="button"
          aria-expanded={expanded}
          disabled={searching}
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left text-sm text-sidebar-muted-foreground/70 hover:text-sidebar-foreground"
        >
          <span className="shrink-0">Work Tasks</span>
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-3 shrink-0 opacity-0 transition-[opacity,transform] group-hover/work-tasks-header:opacity-100 group-focus-within/work-tasks-header:opacity-100",
              !expanded && "-rotate-90 opacity-100",
            )}
          />
        </button>
        <div className="flex shrink-0 items-center">
          <Menu>
            <MenuTrigger
              render={
                <SidebarHeaderIconButton
                  label={
                    hiddenCount > 0 ? `Filter and sort (${hiddenCount} hidden)` : "Filter and sort"
                  }
                />
              }
            >
              <ListFilterIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuGroup>
                <MenuGroupLabel>Show in Work Tasks</MenuGroupLabel>
                {projects.map((project) => {
                  const key = `${project.environmentId}:${project.id}`;
                  return (
                    <MenuCheckboxItem
                      key={key}
                      checked={!hiddenProjectKeys.has(key)}
                      closeOnClick={false}
                      onCheckedChange={(checked) => setProjectHidden(key, !checked)}
                    >
                      <span className="block max-w-56 truncate">{project.title}</span>
                    </MenuCheckboxItem>
                  );
                })}
              </MenuGroup>
              <MenuSeparator />
              <MenuGroup>
                <MenuGroupLabel>Sort Work Tasks by</MenuGroupLabel>
                <MenuRadioGroup
                  value={sort}
                  onValueChange={(value) => {
                    if (isWorkTaskSort(value)) setSort(value);
                  }}
                >
                  {WORK_TASK_SORTS.map((option) => (
                    <MenuRadioItem key={option.value} value={option.value} closeOnClick={false}>
                      {option.label}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuGroup>
            </MenuPopup>
          </Menu>
          <SidebarHeaderIconButton
            label="Work Taskboard"
            onClick={() => {
              closeMobileSidebar();
              void navigate({ to: "/work-tasks" });
            }}
          >
            <SquareKanbanIcon />
          </SidebarHeaderIconButton>
          <SidebarHeaderIconButton label="New Work Task" onClick={() => openNewWorkTaskDialog()}>
            <PlusIcon />
          </SidebarHeaderIconButton>
        </div>
      </div>
      {expanded && groups.length === 0 ? (
        <p className="h-8 ps-2 pe-2 text-sm leading-8 text-sidebar-muted-foreground/70">
          All projects hidden
        </p>
      ) : expanded ? (
        <ul className="flex flex-col gap-1.5 pb-2">
          {groups.map((group) => {
            const projectOpen = isProjectExpanded(group);
            const FolderIcon = projectOpen ? FolderOpenIcon : FolderClosedIcon;
            return (
              <li key={group.key} className="flex flex-col">
                <div className="group/work-task-project flex h-8 items-center gap-2 ps-2 pe-0.5 text-sidebar-foreground/85">
                  <button
                    type="button"
                    aria-expanded={projectOpen}
                    disabled={searching}
                    onClick={() =>
                      setProjectExpanded((value) => ({ ...value, [group.key]: !projectOpen }))
                    }
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left hover:text-sidebar-foreground"
                  >
                    <FolderIcon
                      aria-hidden
                      className="size-4 shrink-0 text-sidebar-muted-foreground"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm">{group.title}</span>
                  </button>
                  <span className="flex opacity-0 group-focus-within/work-task-project:opacity-100 group-hover/work-task-project:opacity-100">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            size="icon-tiny"
                            variant="ghost-muted"
                            aria-label={`New Work Task in ${group.title}`}
                            onClick={() =>
                              openNewWorkTaskDialog({
                                environmentId: group.environmentId,
                                projectId: group.projectId,
                              })
                            }
                          />
                        }
                      >
                        <PlusIcon />
                      </TooltipTrigger>
                      <TooltipPopup side="top">New Work Task in {group.title}</TooltipPopup>
                    </Tooltip>
                  </span>
                </div>
                {!projectOpen ? null : group.views.length === 0 ? (
                  <p className="h-8 ps-8 pe-2 text-sm leading-8 text-sidebar-muted-foreground/70">
                    No Work Tasks
                  </p>
                ) : (
                  <ul className="flex flex-col gap-px">
                    {group.views.map((view) => {
                      const linked = linkedByKey.get(view.key);
                      return (
                        <SidebarWorkTaskRow
                          key={view.key}
                          view={view}
                          active={view.key === activeKey}
                          linkedProjects={
                            linked === undefined
                              ? null
                              : linked
                                  .map(
                                    (sibling) =>
                                      projectTitles.get(
                                        `${sibling.environmentId}:${sibling.projectId}`,
                                      ) ?? sibling.title,
                                  )
                                  .join(", ")
                          }
                          linkedCount={linked?.length ?? 0}
                          highlighted={
                            linked !== undefined && hoveredBranch === view.task.workspace.branch
                          }
                          onHoverLinked={setHoveredBranch}
                          onOpen={(target) => {
                            closeMobileSidebar();
                            openWorkTask(target);
                          }}
                          onContextMenu={openContextMenu}
                        />
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </SidebarGroup>
  );
});

const SidebarWorkTaskRow = memo(function SidebarWorkTaskRow({
  view,
  active,
  linkedProjects,
  linkedCount,
  highlighted,
  onHoverLinked,
  onOpen,
  onContextMenu,
}: {
  view: WorkTaskView;
  active: boolean;
  /** Repositories with a task on the same branch, or null when the task is not linked. */
  linkedProjects: string | null;
  linkedCount: number;
  /** A linked task in another repository is hovered. */
  highlighted: boolean;
  onHoverLinked: (branch: string | null) => void;
  onOpen: (view: WorkTaskView) => void;
  onContextMenu: (view: WorkTaskView, position: { x: number; y: number }) => void;
}) {
  const { task, status, tabs } = view;
  // Live work and waiting outrank a new response, which only replaces calmer statuses.
  const unseen =
    status !== "working" &&
    status !== "monitoring" &&
    status !== "waiting-for-user" &&
    tabs.some(({ shell }) => hasUnseenCompletion({ ...shell, lastVisitedAt: shell.lastVisitedAt }));
  // A process running in any of the task's thread terminals, e.g. a Run script.
  const terminalSessions = useKnownTerminalSessions({
    environmentId: task.environmentId,
    threadId: null,
  });
  const threadIds = new Set<string>(tabs.map(({ shell }) => shell.id));
  const terminalStatus = terminalStatusFromRunningIds(
    selectRunningSubprocessTerminalIds(
      (terminalSessions ?? []).filter((session) => threadIds.has(session.target.threadId)),
    ),
  );
  const detail = [
    unseen ? UNSEEN_RESPONSE_PRESENTATION.label : null,
    WORK_TASK_STATUS_PRESENTATION[status].label,
    terminalStatus?.label ?? null,
    task.workspace.branch,
    view.pullRequest !== null ? `#${view.pullRequest.number}` : null,
    linkedProjects !== null ? `Also in ${linkedProjects}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li>
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        aria-label={`${task.title}, ${detail}`}
        onClick={() => onOpen(view)}
        {...(linkedProjects !== null
          ? {
              onPointerEnter: () => onHoverLinked(task.workspace.branch),
              onPointerLeave: () => onHoverLinked(null),
            }
          : {})}
        onContextMenu={(event: MouseEvent) => {
          event.preventDefault();
          onContextMenu(view, { x: event.clientX, y: event.clientY });
        }}
        className={cn(
          "flex h-8 w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-md ps-8 pe-2 text-left",
          active
            ? "bg-primary/8 text-sidebar-foreground"
            : "text-sidebar-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
          unseen && "font-semibold text-sidebar-foreground",
          highlighted && !active && "bg-primary/8 ring-1 ring-primary/30 ring-inset",
        )}
      >
        {unseen ? (
          <UNSEEN_RESPONSE_PRESENTATION.Icon className={UNSEEN_RESPONSE_PRESENTATION.className} />
        ) : (
          <WorkTaskStatusIcon status={status} />
        )}
        <span className="min-w-0 flex-1 truncate text-sm">{task.title}</span>
        {terminalStatus ? (
          <TerminalIcon
            aria-hidden
            className={cn("size-3.5 shrink-0", terminalStatus.colorClass)}
          />
        ) : null}
        {linkedProjects !== null ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  className={cn(
                    "flex shrink-0 items-center gap-0.5 text-xs tabular-nums",
                    highlighted ? "text-primary" : "text-sidebar-muted-foreground",
                  )}
                />
              }
            >
              <Link2Icon aria-hidden className="size-3.5" />
              {linkedCount}
            </TooltipTrigger>
            <TooltipPopup side="right">Same branch in {linkedProjects}</TooltipPopup>
          </Tooltip>
        ) : null}
      </button>
    </li>
  );
});
