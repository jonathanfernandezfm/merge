import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { readLocalApi } from "~/localApi";
import { readProject, waitForThreadShell } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { workTaskKey, workTaskMenuItems, type WorkTaskMenuId, type WorkTaskView } from "./logic";
import { readLinkedWorkTasks, readWorkTaskView, workTasksEnvironment } from "./state";
import { openArchiveWorkTaskDialog, openWaitingReasonDialog } from "./WorkTaskDialogs";

/** Opens a task on its latest live thread, or on the Work Task page when every tab is closed. */
export function useOpenWorkTask() {
  const navigate = useNavigate();
  return (view: Pick<WorkTaskView, "task" | "latestThread">) => {
    const { task, latestThread } = view;
    void (latestThread !== null
      ? navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: task.environmentId, threadId: latestThread.id },
        })
      : navigate({
          to: "/work-tasks/$environmentId/$taskId",
          params: { environmentId: task.environmentId, taskId: task.id },
        }));
  };
}

/** Creates a thread in a task and opens it. A call while one is in flight is a no-op. */
export function useCreateWorkTaskThread() {
  const navigate = useNavigate();
  const createThread = useAtomCommand(workTasksEnvironment.createThread, "new Work Task thread");
  const inFlightRef = useRef(false);
  const [pending, setPending] = useState(false);
  const createWorkTaskThread = async (task: Pick<WorkTaskView["task"], "environmentId" | "id">) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setPending(true);
    try {
      const result = await createThread({
        environmentId: task.environmentId,
        input: { taskId: task.id },
      });
      if (result._tag !== "Success") return;
      const threadRef = { environmentId: task.environmentId, threadId: result.value.threadId };
      await waitForThreadShell(threadRef).catch(() => undefined);
      await navigate({ to: "/$environmentId/$threadId", params: threadRef });
    } finally {
      inFlightRef.current = false;
      setPending(false);
    }
  };
  return { createWorkTaskThread, pending };
}

function projectTitle(task: WorkTaskView["task"]): string {
  return (
    readProject({ environmentId: task.environmentId, projectId: task.projectId })?.title ??
    task.title
  );
}

/** The task right-click menu. `onNavigate` runs before the menu opens another thread. */
export function useWorkTaskContextMenu(onNavigate?: () => void) {
  const { createWorkTaskThread } = useCreateWorkTaskThread();
  const openWorkTask = useOpenWorkTask();
  const setWaiting = useAtomCommand(workTasksEnvironment.setWaiting, "Work Task update");
  const setAutoHandle = useAtomCommand(workTasksEnvironment.setAutoHandle, "Work Task update");
  return async (view: WorkTaskView, position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return;
    const { task } = view;
    const linked = readLinkedWorkTasks(view.key);
    const clicked = await settlePromise(() =>
      api.contextMenu.show<WorkTaskMenuId>(
        [...workTaskMenuItems({ task, linkedProjectTitles: linked.map(projectTitle) })],
        position,
      ),
    );
    if (clicked._tag === "Failure" || clicked.value == null) return;
    const taskRef = { environmentId: task.environmentId, taskId: task.id };
    if (clicked.value.startsWith("open-linked:")) {
      const sibling = linked[Number(clicked.value.slice("open-linked:".length))];
      const siblingView =
        sibling === undefined
          ? null
          : readWorkTaskView(workTaskKey(sibling.environmentId, sibling.id));
      if (siblingView === null) return;
      onNavigate?.();
      openWorkTask(siblingView);
      return;
    }
    switch (clicked.value) {
      case "new-thread":
        onNavigate?.();
        await createWorkTaskThread(task);
        return;
      case "mark-waiting":
        openWaitingReasonDialog(taskRef);
        return;
      case "clear-waiting":
        await setWaiting({
          environmentId: task.environmentId,
          input: { taskId: task.id, reason: null },
        });
        return;
      case "auto-handle":
        await setAutoHandle({
          environmentId: task.environmentId,
          input: { taskId: task.id, enabled: !task.autoHandleReviewFeedback },
        });
        return;
      case "archive":
        openArchiveWorkTaskDialog(taskRef);
        return;
    }
  };
}
