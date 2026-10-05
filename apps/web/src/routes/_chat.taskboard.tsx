import {
  groupTaskboardTasks,
  TASKBOARD_COLUMNS,
  type EnvironmentTask,
  type TaskboardColumnId,
} from "@t3tools/client-runtime/state/tasks";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { createFileRoute } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

import {
  TaskBoardCard,
  threadProviderEntry,
  type TaskBoardCardData,
} from "../components/task/TaskBoardCard";
import { openNewTaskDialog } from "../components/task/TaskDialogs";
import { ToneDot } from "../components/task/taskPresentation";
import { useOpenTask, useTaskContextMenu } from "../components/task/useTaskActions";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { useNowMinute } from "../hooks/useNowMinute";
import { cn } from "../lib/utils";
import { deriveProviderEntriesByEnvironment } from "../providerInstances";
import { useProjects } from "../state/entities";
import { environmentServerConfigsAtom } from "../state/server";
import { taskThreadsKey, useTasks, useTaskThreadsByTask } from "../state/tasks";

const EMPTY_THREADS: ReadonlyArray<EnvironmentThreadShell> = [];
const EMPTY_CARDS: ReadonlyArray<TaskBoardCardData> = [];

const BOARD_COLUMNS = TASKBOARD_COLUMNS.filter((column) => column.id !== "archive");
const ARCHIVE_COLUMN = TASKBOARD_COLUMNS.find((column) => column.id === "archive")!;

const EMPTY_COLUMN_COPY: Readonly<Record<TaskboardColumnId, string>> = {
  working: "Nothing in progress",
  "needs-you": "Nothing needs you",
  "in-review": "Nothing in review",
  "ready-to-merge": "Nothing ready to merge",
  merged: "Nothing merged yet",
  archive: "Archived tasks show up here.",
};

/** Every task across projects and environments, one card each, by what it needs next. */
function TaskboardRouteView() {
  const tasks = useTasks();
  const threadsByTask = useTaskThreadsByTask();
  const projects = useProjects();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const openTask = useOpenTask();
  const openTaskContextMenu = useTaskContextMenu();
  const [archiveOpen, setArchiveOpen] = useState(false);
  // Default instance ids are driver slugs, so lookups stay scoped per environment.
  const providerEntriesByEnvironment = useMemo(
    () =>
      deriveProviderEntriesByEnvironment(
        [...serverConfigs].map(
          ([environmentId, config]) => [environmentId, config.providers] as const,
        ),
      ),
    [serverConfigs],
  );
  // Re-render relative times once a minute; nothing here animates.
  useNowMinute();

  const projectNameByKey = useMemo(
    () =>
      new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project.title])),
    [projects],
  );
  const columns = useMemo(
    () =>
      groupTaskboardTasks(
        tasks,
        (task) => threadsByTask.get(taskThreadsKey(task.environmentId, task.id)) ?? EMPTY_THREADS,
      ),
    [tasks, threadsByTask],
  );
  const archived = columns.get("archive") ?? EMPTY_CARDS;

  const renderCard = (card: TaskBoardCardData, compact = false) => (
    <li key={taskThreadsKey(card.task.environmentId, card.task.id)}>
      <TaskBoardCard
        card={card}
        compact={compact}
        projectName={projectNameOf(projectNameByKey, card.task)}
        provider={threadProviderEntry(
          card.latestThread,
          providerEntriesByEnvironment.get(card.task.environmentId),
        )}
        onOpen={openTask}
        onContextMenu={openTaskContextMenu}
      />
    </li>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <WorkspacePageHeader electron={isElectron} className="relative bg-background">
          <WorkspaceBreadcrumb ariaLabel="Board breadcrumb">
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">Board</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <div className="min-w-0 flex-1" />
          <Button size="sm" variant="outline" onClick={() => openNewTaskDialog()}>
            <PlusIcon />
            New task
          </Button>
        </WorkspacePageHeader>
        {tasks.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No tasks yet</EmptyTitle>
              <EmptyDescription>
                Create a task from an existing remote branch to track it here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <div className="grid min-h-0 flex-1 grid-cols-[repeat(5,minmax(15rem,1fr))] gap-3 overflow-x-auto p-3">
              {BOARD_COLUMNS.map((column) => {
                const cards = columns.get(column.id) ?? EMPTY_CARDS;
                const headingId = `taskboard-${column.id}`;
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
            <section aria-labelledby="taskboard-archive" className="shrink-0 border-t">
              <h2 id="taskboard-archive">
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
                  {ARCHIVE_COLUMN.label}
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

function projectNameOf(projectNameByKey: ReadonlyMap<string, string>, task: EnvironmentTask) {
  return projectNameByKey.get(`${task.environmentId}:${task.projectId}`) ?? "Unknown project";
}

export const Route = createFileRoute("/_chat/taskboard")({
  component: TaskboardRouteView,
});
