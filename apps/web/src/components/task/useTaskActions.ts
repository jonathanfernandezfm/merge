import type { EnvironmentTask } from "@t3tools/client-runtime/state/tasks";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { readLocalApi } from "~/localApi";
import { taskEnvironment } from "~/state/tasks";
import { useAtomCommand } from "~/state/use-atom-command";
import { openArchiveTaskDialog, openWaitingReasonDialog } from "./TaskDialogs";
import { useCreateTaskThread } from "./TaskWorkspaceBar";

type TaskAction = "new-thread" | "mark-waiting" | "clear-waiting" | "archive";

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
 * The task right-click menu: new thread, mark or clear waiting for user, and
 * archive. `onNewThread` runs before a new thread opens.
 */
export function useTaskContextMenu(onNewThread?: () => void) {
  const { createTaskThread } = useCreateTaskThread();
  const updateTask = useAtomCommand(taskEnvironment.updateMetadata, "task update");
  return useCallback(
    async (task: EnvironmentTask, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const taskRef = { environmentId: task.environmentId, taskId: task.id };
      const waiting = task.waitingForUserReason !== null;
      const clicked = await settlePromise(() =>
        api.contextMenu.show<TaskAction>(
          [
            { id: "new-thread", label: "New thread" },
            waiting
              ? { id: "clear-waiting", label: "Clear waiting for user" }
              : { id: "mark-waiting", label: "Mark waiting for user..." },
            { id: "archive", label: "Archive task...", destructive: true, separatorBefore: true },
          ],
          position,
        ),
      );
      if (clicked._tag === "Failure") return;
      switch (clicked.value) {
        case "new-thread":
          onNewThread?.();
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
    [createTaskThread, onNewThread, updateTask],
  );
}
