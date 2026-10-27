import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { useNavigate } from "@tanstack/react-router";
import {
  FoldVerticalIcon,
  GitGraphIcon,
  ListTodoIcon,
  SquareKanbanIcon,
  SquarePlusIcon,
} from "lucide-react";

import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "~/components/CommandPalette.logic";
import { toggleCompactThreads } from "./folders/compact";
import { GIT_GRAPH_SURFACE_ID, openMergeSurface } from "./gitGraph/surface";
import { WORK_ITEMS_SURFACE_ID } from "./workItems/state";
import { openNewWorkTaskDialog } from "./workTasks/WorkTaskDialogs";

/** Fork actions for the command palette, appended at the `command-palette` seam. */
export function mergeCommandPaletteActions(
  thread: { readonly environmentId: EnvironmentId; readonly id: ThreadId } | null | undefined,
  navigate: ReturnType<typeof useNavigate>,
): CommandPaletteActionItem[] {
  const workTaskActions: CommandPaletteActionItem[] = [
    {
      kind: "action",
      value: "action:new-work-task",
      searchTerms: ["new work task", "task", "branch", "worktree"],
      title: "New Work Task…",
      icon: <SquarePlusIcon className={ITEM_ICON_CLASS} />,
      run: async () => openNewWorkTaskDialog(),
    },
    {
      kind: "action",
      value: "action:open-work-taskboard",
      searchTerms: ["work taskboard", "work tasks", "board", "kanban"],
      title: "Open Work Taskboard",
      icon: <SquareKanbanIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({ to: "/work-tasks" });
      },
    },
    {
      kind: "action",
      value: "action:toggle-compact-thread-rows",
      searchTerms: ["compact thread rows", "dense", "density", "sidebar", "branch"],
      title: "Toggle compact thread rows",
      icon: <FoldVerticalIcon className={ITEM_ICON_CLASS} />,
      run: async () => toggleCompactThreads(),
    },
  ];
  if (!thread) return workTaskActions;
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  return [
    ...workTaskActions,
    {
      kind: "action",
      value: "action:open-git-graph",
      searchTerms: ["git graph", "commits", "history", "log", "compare branch"],
      title: "Open Git graph",
      icon: <GitGraphIcon className={ITEM_ICON_CLASS} />,
      run: async () => openMergeSurface(threadRef, GIT_GRAPH_SURFACE_ID),
    },
    {
      kind: "action",
      value: "action:open-work-items",
      searchTerms: ["work items", "azure boards", "azure devops", "subtasks", "ticket"],
      title: "Open work items",
      icon: <ListTodoIcon className={ITEM_ICON_CLASS} />,
      run: async () => openMergeSurface(threadRef, WORK_ITEMS_SURFACE_ID),
    },
  ];
}
