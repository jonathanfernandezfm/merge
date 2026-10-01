import {
  latestTaskThread,
  resolveTaskStatus,
  type EnvironmentTask,
} from "@t3tools/client-runtime/state/tasks";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, TaskId } from "@t3tools/contracts";
import { TASK_STATUS_PRESENTATION } from "@t3tools/shared/taskStatus";
import { useNavigate, useParams } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { ChevronDownIcon, FolderOpenIcon, PlusIcon, SquareKanbanIcon } from "lucide-react";
import { memo, useCallback, useMemo, type MouseEvent, type ReactNode } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { useProjects, useThreadShell } from "~/state/entities";
import { taskThreadsKey, useTasks, useTaskThreadsByTask } from "~/state/tasks";
import { Button } from "../ui/button";
import { SidebarHeaderIconButton } from "../sidebar/SidebarThreadHeader";
import { SidebarGroup, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { openNewTaskDialog } from "./TaskDialogs";
import { TaskStatusIcon, UNSEEN_RESPONSE_PRESENTATION } from "./taskPresentation";
import { useUnseenThreadFlags } from "./useUnseenThreads";
import { useOpenTask, useTaskContextMenu } from "./useTaskActions";

const EMPTY_THREADS: ReadonlyArray<EnvironmentThreadShell> = [];
const TASKS_EXPANDED_KEY = "t3code:sidebar:tasks-expanded";

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
 * Projects with their active tasks. Archived tasks leave the sidebar; their
 * history stays on the Taskboard. Renders nothing without an active task (or,
 * while the sidebar searches, without a task whose title or branch matches
 * `searchQuery`); the Taskboard stays reachable from the utility menu and the
 * command palette.
 */
export const SidebarTasks = memo(function SidebarTasks({
  searchQuery = "",
}: {
  searchQuery?: string;
}) {
  const tasks = useTasks();
  const projects = useProjects();
  const threadsByTask = useTaskThreadsByTask();
  const activeTaskKey = useActiveTaskKey();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const [storedExpanded, setExpanded] = useLocalStorage(TASKS_EXPANDED_KEY, true, Schema.Boolean);
  const query = searchQuery.trim().toLowerCase();
  const searching = query.length > 0;
  // Matches would hide behind a collapsed section.
  const expanded = searching || storedExpanded;

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
      const projectTasks = byProject.get(key);
      if (projectTasks === undefined) return [];
      return [
        {
          key,
          environmentId: project.environmentId,
          projectId: project.id,
          title: project.title,
          tasks: projectTasks.toSorted((left, right) =>
            right.createdAt.localeCompare(left.createdAt),
          ),
        },
      ];
    });
  }, [projects, query, tasks]);

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

  if (groups.length === 0) return null;

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
      {expanded ? (
        <ul className="flex flex-col gap-1.5 pb-2">
          {groups.map((group) => (
            <li key={group.key} className="flex flex-col">
              <div className="group/task-project flex h-8 items-center gap-2 ps-2 pe-0.5 text-sidebar-foreground/85">
                <FolderOpenIcon
                  aria-hidden
                  className="size-4 shrink-0 text-sidebar-muted-foreground"
                />
                <span className="min-w-0 flex-1 truncate text-sm">{group.title}</span>
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
              <ul className="flex flex-col gap-px">
                {group.tasks.map((task) => {
                  const key = taskThreadsKey(task.environmentId, task.id);
                  return (
                    <SidebarTaskRow
                      key={key}
                      task={task}
                      threads={threadsByTask.get(key) ?? EMPTY_THREADS}
                      active={key === activeTaskKey}
                      onOpen={openTask}
                      onContextMenu={openTaskContextMenu}
                    />
                  );
                })}
              </ul>
            </li>
          ))}
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
  onOpen,
  onContextMenu,
}: {
  task: EnvironmentTask;
  threads: ReadonlyArray<EnvironmentThreadShell>;
  active: boolean;
  onOpen: (task: EnvironmentTask, threads: ReadonlyArray<EnvironmentThreadShell>) => void;
  onContextMenu: (task: EnvironmentTask, position: { x: number; y: number }) => void;
}) {
  const status = resolveTaskStatus(task, threads);
  const statusLabel = TASK_STATUS_PRESENTATION[status].label;
  // Working and waiting outrank a new response, which only replaces calmer statuses.
  const unseen =
    useUnseenThreadFlags(threads).includes(true) &&
    status !== "working" &&
    status !== "waiting-for-user";
  const detail = [
    unseen ? UNSEEN_RESPONSE_PRESENTATION.label : null,
    statusLabel,
    task.workspace.branch,
    task.pullRequest !== null ? `#${task.pullRequest.number}` : null,
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
        onContextMenu={(event: MouseEvent) => {
          event.preventDefault();
          onContextMenu(task, { x: event.clientX, y: event.clientY });
        }}
        className={cn(
          "flex h-8 w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-md ps-8 pe-2 text-left",
          active
            ? "bg-sidebar-row-hover text-sidebar-foreground"
            : "text-sidebar-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
          unseen && "font-semibold text-sidebar-foreground",
        )}
      >
        {unseen ? (
          <UNSEEN_RESPONSE_PRESENTATION.Icon className={UNSEEN_RESPONSE_PRESENTATION.className} />
        ) : (
          <TaskStatusIcon status={status} />
        )}
        <span className="min-w-0 flex-1 truncate text-sm">{task.title}</span>
      </button>
    </li>
  );
});
