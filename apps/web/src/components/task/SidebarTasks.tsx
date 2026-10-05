import {
  latestTaskThread,
  resolveTaskStatus,
  taskActivityAt,
  type EnvironmentTask,
} from "@t3tools/client-runtime/state/tasks";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, TaskId } from "@t3tools/contracts";
import { TASK_STATUS_PRESENTATION, TASK_STATUSES } from "@t3tools/shared/taskStatus";
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
import { memo, useCallback, useMemo, useState, type MouseEvent, type ReactNode } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { useProjects, useThreadShell } from "~/state/entities";
import {
  taskThreadsKey,
  useLinkedTasksByTask,
  useTasks,
  useTaskThreadsByTask,
} from "~/state/tasks";
import { useKnownTerminalSessions } from "~/state/terminalSessions";
import { synchronizeTerminalPulse, terminalStatusFromRunningIds } from "../ThreadStatusIndicators";
import { Button } from "../ui/button";
import { SidebarHeaderIconButton } from "../sidebar/SidebarThreadHeader";
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
} from "../ui/menu";
import { SidebarGroup, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { openNewTaskDialog } from "./TaskDialogs";
import { TaskStatusIcon, UNSEEN_RESPONSE_PRESENTATION } from "./taskPresentation";
import { useUnseenThreadFlags } from "./useUnseenThreads";
import { useOpenTask, useTaskContextMenu } from "./useTaskActions";

const EMPTY_THREADS: ReadonlyArray<EnvironmentThreadShell> = [];
const TASKS_EXPANDED_KEY = "t3code:sidebar:tasks-expanded";
const PROJECTS_EXPANDED_KEY = "t3code:sidebar:task-projects-expanded";
const HIDDEN_PROJECTS_KEY = "t3code:sidebar:task-projects-hidden";
const TASK_SORT_KEY = "t3code:sidebar:task-sort";
const ProjectsExpandedSchema = Schema.Record(Schema.String, Schema.Boolean);
const HiddenProjectsSchema = Schema.Array(Schema.String);
const NO_HIDDEN_PROJECTS: ReadonlyArray<string> = [];

const TASK_SORTS = [
  { value: "newest", label: "Newest" },
  { value: "activity", label: "Recent activity" },
  { value: "status", label: "Status" },
] as const;
type TaskSort = (typeof TASK_SORTS)[number]["value"];
const TaskSortSchema = Schema.Literals(TASK_SORTS.map((sort) => sort.value));

function isTaskSort(value: unknown): value is TaskSort {
  return TASK_SORTS.some((sort) => sort.value === value);
}

/**
 * A project's tasks in the chosen order. Status follows the task lifecycle;
 * activity breaks ties so the task you touched last leads its status.
 */
function sortProjectTasks(
  tasks: ReadonlyArray<EnvironmentTask>,
  sort: TaskSort,
  threadsOf: (task: EnvironmentTask) => ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<EnvironmentTask> {
  if (sort === "newest") {
    return tasks.toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
  }
  return tasks
    .map((task) => {
      const threads = threadsOf(task);
      return {
        task,
        rank: sort === "status" ? TASK_STATUSES.indexOf(resolveTaskStatus(task, threads)) : 0,
        activityAt: taskActivityAt(task, latestTaskThread(threads)),
      };
    })
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        right.activityAt.localeCompare(left.activityAt) ||
        left.task.id.localeCompare(right.task.id),
    )
    .map((entry) => entry.task);
}

function taskMatchesQuery(task: EnvironmentTask, query: string): boolean {
  return (
    task.title.toLowerCase().includes(query) || task.workspace.branch.toLowerCase().includes(query)
  );
}

interface TaskProjectGroup {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: EnvironmentTask["projectId"];
  readonly title: string;
  readonly tasks: ReadonlyArray<EnvironmentTask>;
}

/** The task the current route shows, from a task thread or the task page. */
function useActiveTaskKey(): string | null {
  const params = useParams({
    strict: false,
    select: (value) => ({
      environmentId: value.environmentId as EnvironmentId | undefined,
      threadId: "threadId" in value ? (value.threadId as string | undefined) : undefined,
      taskId: "taskId" in value ? (value.taskId as string | undefined) : undefined,
    }),
  });
  const thread = useThreadShell(
    params.environmentId && params.threadId
      ? {
          environmentId: params.environmentId,
          threadId: params.threadId as EnvironmentThreadShell["id"],
        }
      : null,
  );
  if (!params.environmentId) return null;
  const taskId = params.taskId ?? thread?.taskId ?? null;
  return taskId === null ? null : taskThreadsKey(params.environmentId, taskId as TaskId);
}

/**
 * Every project with its active tasks; projects without tasks start collapsed.
 * The header menu hides projects and orders tasks within each project;
 * search still reaches hidden projects' tasks so a match never disappears.
 * Archived tasks leave the sidebar; their history stays on the Taskboard.
 * While the sidebar searches, only projects with a task whose title or branch
 * matches `searchQuery` render. Renders nothing when nothing is left to show;
 * the Taskboard stays reachable from the utility menu and the command palette.
 */
export const SidebarTasks = memo(function SidebarTasks({
  searchQuery = "",
}: {
  searchQuery?: string;
}) {
  const tasks = useTasks();
  const projects = useProjects();
  const threadsByTask = useTaskThreadsByTask();
  const linkedByTask = useLinkedTasksByTask();
  // Hovering a linked task highlights the same branch in the other repos.
  const [hoveredBranch, setHoveredBranch] = useState<string | null>(null);
  const activeTaskKey = useActiveTaskKey();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const [storedExpanded, setExpanded] = useLocalStorage(TASKS_EXPANDED_KEY, true, Schema.Boolean);
  const query = searchQuery.trim().toLowerCase();
  const searching = query.length > 0;
  // Matches would hide behind a collapsed section.
  const expanded = searching || storedExpanded;
  const [hiddenProjects, setHiddenProjects] = useLocalStorage(
    HIDDEN_PROJECTS_KEY,
    NO_HIDDEN_PROJECTS,
    HiddenProjectsSchema,
  );
  const [taskSort, setTaskSort] = useLocalStorage(TASK_SORT_KEY, "newest", TaskSortSchema);
  const hiddenProjectKeys = useMemo(() => new Set(hiddenProjects), [hiddenProjects]);
  const setProjectHidden = useCallback(
    (key: string, hidden: boolean) =>
      setHiddenProjects((value) =>
        hidden
          ? [...value.filter((entry) => entry !== key), key]
          : value.filter((entry) => entry !== key),
      ),
    [setHiddenProjects],
  );
  // Only projects that still exist count, so stale keys never keep the section alive.
  const hiddenCount = projects.filter((project) =>
    hiddenProjectKeys.has(`${project.environmentId}:${project.id}`),
  ).length;

  const groups = useMemo((): ReadonlyArray<TaskProjectGroup> => {
    const byProject = new Map<string, EnvironmentTask[]>();
    for (const task of tasks) {
      if (task.archivedAt !== null) continue;
      if (query.length > 0 && !taskMatchesQuery(task, query)) continue;
      const key = `${task.environmentId}:${task.projectId}`;
      const list = byProject.get(key);
      if (list === undefined) byProject.set(key, [task]);
      else list.push(task);
    }
    return projects.flatMap((project) => {
      const key = `${project.environmentId}:${project.id}`;
      const projectTasks = byProject.get(key) ?? [];
      // Searching narrows to projects with a matching task, hidden or not.
      if (searching ? projectTasks.length === 0 : hiddenProjectKeys.has(key)) return [];
      return [
        {
          key,
          environmentId: project.environmentId,
          projectId: project.id,
          title: project.title,
          tasks: sortProjectTasks(
            projectTasks,
            taskSort,
            (task) =>
              threadsByTask.get(taskThreadsKey(task.environmentId, task.id)) ?? EMPTY_THREADS,
          ),
        },
      ];
    });
  }, [hiddenProjectKeys, projects, query, searching, taskSort, tasks, threadsByTask]);

  const projectTitles = useMemo(
    () =>
      new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project.title])),
    [projects],
  );

  // Explicit toggles per project; untouched projects open only when they have tasks.
  const [projectExpanded, setProjectExpanded] = useLocalStorage(
    PROJECTS_EXPANDED_KEY,
    {},
    ProjectsExpandedSchema,
  );
  const isProjectExpanded = (group: TaskProjectGroup) =>
    searching || (projectExpanded[group.key] ?? group.tasks.length > 0);
  const toggleProject = (group: TaskProjectGroup) =>
    setProjectExpanded((value) => ({ ...value, [group.key]: !isProjectExpanded(group) }));

  const closeMobileSidebar = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  const openTaskTarget = useOpenTask();
  const openTask = useCallback(
    (task: EnvironmentTask, threads: ReadonlyArray<EnvironmentThreadShell>) => {
      closeMobileSidebar();
      openTaskTarget(task, latestTaskThread(threads));
    },
    [closeMobileSidebar, openTaskTarget],
  );

  const openTaskContextMenu = useTaskContextMenu(closeMobileSidebar);

  // Keep the header while projects are hidden; it holds the way back.
  if (groups.length === 0 && (searching || hiddenCount === 0)) return null;

  return (
    <SidebarGroup className="shrink-0">
      <div className="group/tasks-header flex h-8 items-center gap-1 ps-2">
        <button
          type="button"
          aria-expanded={expanded}
          disabled={searching}
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left text-sm text-sidebar-muted-foreground/70 hover:text-sidebar-foreground"
        >
          <span className="shrink-0">Tasks</span>
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-3 shrink-0 opacity-0 transition-[opacity,transform] group-hover/tasks-header:opacity-100 group-focus-within/tasks-header:opacity-100",
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
                <MenuGroupLabel>Show in Tasks</MenuGroupLabel>
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
                <MenuGroupLabel>Sort tasks by</MenuGroupLabel>
                <MenuRadioGroup
                  value={taskSort}
                  onValueChange={(value) => {
                    if (isTaskSort(value)) setTaskSort(value);
                  }}
                >
                  {TASK_SORTS.map((sort) => (
                    <MenuRadioItem key={sort.value} value={sort.value} closeOnClick={false}>
                      {sort.label}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuGroup>
            </MenuPopup>
          </Menu>
          <SidebarHeaderIconButton
            label="Taskboard"
            onClick={() => {
              closeMobileSidebar();
              void navigate({ to: "/taskboard" });
            }}
          >
            <SquareKanbanIcon />
          </SidebarHeaderIconButton>
          <SidebarHeaderIconButton label="New task" onClick={() => openNewTaskDialog()}>
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
                <div className="group/task-project flex h-8 items-center gap-2 ps-2 pe-0.5 text-sidebar-foreground/85">
                  <button
                    type="button"
                    aria-expanded={projectOpen}
                    disabled={searching}
                    onClick={() => toggleProject(group)}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left hover:text-sidebar-foreground"
                  >
                    <FolderIcon
                      aria-hidden
                      className="size-4 shrink-0 text-sidebar-muted-foreground"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm">{group.title}</span>
                  </button>
                  <span className="flex opacity-0 group-focus-within/task-project:opacity-100 group-hover/task-project:opacity-100">
                    <TaskIconAction
                      label={`New task in ${group.title}`}
                      onClick={() =>
                        openNewTaskDialog({
                          environmentId: group.environmentId,
                          projectId: group.projectId,
                        })
                      }
                    >
                      <PlusIcon />
                    </TaskIconAction>
                  </span>
                </div>
                {!projectOpen ? null : group.tasks.length === 0 ? (
                  <p className="h-8 ps-8 pe-2 text-sm leading-8 text-sidebar-muted-foreground/70">
                    No tasks
                  </p>
                ) : (
                  <ul className="flex flex-col gap-px">
                    {group.tasks.map((task) => {
                      const key = taskThreadsKey(task.environmentId, task.id);
                      const linked = linkedByTask.get(key);
                      return (
                        <SidebarTaskRow
                          key={key}
                          task={task}
                          threads={threadsByTask.get(key) ?? EMPTY_THREADS}
                          active={key === activeTaskKey}
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
                            linked !== undefined && hoveredBranch === task.workspace.branch
                          }
                          onHoverLinked={setHoveredBranch}
                          onOpen={openTask}
                          onContextMenu={openTaskContextMenu}
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

function TaskIconAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button size="icon-tiny" variant="ghost-muted" aria-label={label} onClick={onClick} />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

const SidebarTaskRow = memo(function SidebarTaskRow({
  task,
  threads,
  active,
  linkedProjects,
  linkedCount,
  highlighted,
  onHoverLinked,
  onOpen,
  onContextMenu,
}: {
  task: EnvironmentTask;
  threads: ReadonlyArray<EnvironmentThreadShell>;
  active: boolean;
  /** Repos with a task on the same branch, or null when the task is not linked. */
  linkedProjects: string | null;
  linkedCount: number;
  /** A linked task in another repo is hovered. */
  highlighted: boolean;
  onHoverLinked: (branch: string | null) => void;
  onOpen: (task: EnvironmentTask, threads: ReadonlyArray<EnvironmentThreadShell>) => void;
  onContextMenu: (task: EnvironmentTask, position: { x: number; y: number }) => void;
}) {
  const status = resolveTaskStatus(task, threads);
  const statusLabel = TASK_STATUS_PRESENTATION[status].label;
  // Live work and waiting outrank a new response, which only replaces calmer statuses.
  const unseen =
    useUnseenThreadFlags(threads).includes(true) &&
    status !== "working" &&
    status !== "monitoring" &&
    status !== "waiting-for-user";
  // A process running in any of the task's thread terminals, e.g. a Run script.
  const terminalSessions = useKnownTerminalSessions({
    environmentId: task.environmentId,
    threadId: null,
  });
  const runningTerminalIds = useMemo(() => {
    const threadIds = new Set<string>(threads.map((thread) => thread.id));
    return terminalSessions
      .filter(
        (session) => session.state.hasRunningSubprocess && threadIds.has(session.target.threadId),
      )
      .map((session) => session.target.terminalId);
  }, [terminalSessions, threads]);
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const detail = [
    unseen ? UNSEEN_RESPONSE_PRESENTATION.label : null,
    statusLabel,
    terminalStatus?.label ?? null,
    task.workspace.branch,
    task.pullRequest !== null ? `#${task.pullRequest.number}` : null,
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
        onClick={() => onOpen(task, threads)}
        {...(linkedProjects !== null
          ? {
              onPointerEnter: () => onHoverLinked(task.workspace.branch),
              onPointerLeave: () => onHoverLinked(null),
            }
          : {})}
        onContextMenu={(event: MouseEvent) => {
          event.preventDefault();
          onContextMenu(task, { x: event.clientX, y: event.clientY });
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
          <TaskStatusIcon status={status} />
        )}
        <span className="min-w-0 flex-1 truncate text-sm">{task.title}</span>
        {terminalStatus ? (
          <TerminalIcon
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0",
              terminalStatus.colorClass,
              terminalStatus.pulse && "motion-safe:animate-status-pulse",
            )}
            onAnimationStart={synchronizeTerminalPulse}
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
