import { latestTaskThread, type EnvironmentTask } from "@t3tools/client-runtime/state/tasks";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { readLocalApi } from "~/localApi";
import { readProject } from "~/state/entities";
import { readLinkedTasks, readTaskThreadShells, taskEnvironment } from "~/state/tasks";
import { useAtomCommand } from "~/state/use-atom-command";
import { openArchiveTaskDialog, openWaitingReasonDialog } from "./TaskDialogs";
import { useCreateTaskThread } from "./TaskWorkspaceBar";

type TaskAction =
  | "new-thread"
  | "mark-waiting"
  | "clear-waiting"
  | "archive"
  | `open-linked:${number}`;

/** Opens a task on its latest live thread, or on the task page when every tab is closed. */
export function useOpenTask() {
  const navigate = useNavigate();
  return useCallback(
    (task: EnvironmentTask, latestThread: Pick<EnvironmentThreadShell, "id"> | null) => {
      void (latestThread !== null
        ? navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId: task.environmentId, threadId: latestThread.id },
          })
        : navigate({
            to: "/tasks/$environmentId/$taskId",
            params: { environmentId: task.environmentId, taskId: task.id },
          }));
    },
    [navigate],
  );
}

/**
 * The task right-click menu: new thread, open the same branch in a linked
 * repo, mark or clear waiting for user, and archive. `onNavigate` runs before
 * the menu opens another thread.
 */
export function useTaskContextMenu(onNavigate?: () => void) {
  const { createTaskThread } = useCreateTaskThread();
  const openTask = useOpenTask();
  const updateTask = useAtomCommand(taskEnvironment.updateMetadata, "task update");
  return useCallback(
    async (task: EnvironmentTask, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const taskRef = { environmentId: task.environmentId, taskId: task.id };
      const waiting = task.waitingForUserReason !== null;
      const linked = readLinkedTasks(task);
      const clicked = await settlePromise(() =>
        api.contextMenu.show<TaskAction>(
          [
            { id: "new-thread", label: "New thread" },
            ...linked.map((sibling, index) => ({
              id: `open-linked:${index}` as const,
              label: `Open in ${
                readProject({ environmentId: sibling.environmentId, projectId: sibling.projectId })
                  ?.title ?? sibling.title
              }`,
              separatorBefore: index === 0,
            })),
            waiting
              ? {
                  id: "clear-waiting",
                  label: "Clear waiting for user",
                  separatorBefore: linked.length > 0,
                }
              : {
                  id: "mark-waiting",
                  label: "Mark waiting for user...",
                  separatorBefore: linked.length > 0,
                },
            { id: "archive", label: "Archive task...", destructive: true, separatorBefore: true },
          ],
          position,
        ),
      );
      if (clicked._tag === "Failure") return;
      if (clicked.value?.startsWith("open-linked:")) {
        const sibling = linked[Number(clicked.value.slice("open-linked:".length))];
        if (sibling === undefined) return;
        onNavigate?.();
        openTask(
          sibling,
          latestTaskThread(
            readTaskThreadShells({ environmentId: sibling.environmentId, taskId: sibling.id }),
          ),
        );
        return;
      }
      switch (clicked.value) {
        case "new-thread":
          onNavigate?.();
          await createTaskThread(task);
          return;
        case "mark-waiting":
          openWaitingReasonDialog(taskRef);
          return;
        case "clear-waiting":
          await updateTask({
            environmentId: task.environmentId,
            input: { taskId: task.id, waitingForUserReason: null },
          });
          return;
        case "archive":
          openArchiveTaskDialog(taskRef);
          return;
        default:
          return;
      }
    },
    [createTaskThread, onNavigate, openTask, updateTask],
  );
}
