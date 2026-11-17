import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { readLocalApi } from "~/localApi";
import { readProject, waitForThreadShell } from "~/state/entities";
import { readEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "~/components/ui/toast";
import { copyText } from "../workItems/workItemPresentation";
import type { WorkTaskItem } from "./grouping";
import {
  latestWorkTaskMember,
  workTaskItemMenuItems,
  workTaskKey,
  type WorkTaskView,
} from "./logic";
import { readLinkedWorkTasks, readWorkTaskView, workTasksEnvironment } from "./state";
import {
  openArchiveWorkTaskDialog,
  openRenameWorkTaskDialog,
  openWaitingReasonDialog,
} from "./WorkTaskDialogs";

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
    // Promise `finally`, not `try`/`finally`: React Compiler cannot compile the latter.
    const run = async () => {
      const result = await createThread({
        environmentId: task.environmentId,
        input: { taskId: task.id },
      });
      if (result._tag !== "Success") return;
      const threadRef = { environmentId: task.environmentId, threadId: result.value.threadId };
      await waitForThreadShell(threadRef).catch(() => undefined);
      await navigate({ to: "/$environmentId/$threadId", params: threadRef });
    };
    await run().finally(() => {
      inFlightRef.current = false;
      setPending(false);
    });
  };
  return { createWorkTaskThread, pending };
}

function projectTitle(task: WorkTaskView["task"]): string {
  return (
    readProject({ environmentId: task.environmentId, projectId: task.projectId })?.title ??
    task.title
  );
}

/** The work item right-click menu. `onNavigate` runs before the menu opens another thread. */
export function useWorkTaskContextMenu(onNavigate?: () => void) {
  const { createWorkTaskThread } = useCreateWorkTaskThread();
  const openWorkTask = useOpenWorkTask();
  const setWaiting = useAtomCommand(workTasksEnvironment.setWaiting, "Work Task update");
  const setAutoHandle = useAtomCommand(workTasksEnvironment.setAutoHandle, "Work Task update");
  const rename = useAtomCommand(workTasksEnvironment.rename, "Work Task rename");
  const archive = useAtomCommand(workTasksEnvironment.archive, "Work Task archive");
  return async (item: WorkTaskItem, position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return;
    const tasks = item.members.map((member) => member.view.task);
    const latest = latestWorkTaskMember(item).view;
    const linked = readLinkedWorkTasks(latest.key);
    const clicked = await settlePromise(() =>
      api.contextMenu.show<string>(
        workTaskItemMenuItems(item, {
          linkedProjectTitles: linked.map(projectTitle),
          canOperate: tasks.every((task) =>
            readEnvironmentScope(task.environmentId, AuthOrchestrationOperateScope),
          ),
        }),
        position,
      ),
    );
    if (clicked._tag === "Failure" || clicked.value == null) return;
    const id = clicked.value;
    const refs = tasks.map((task) => ({ environmentId: task.environmentId, taskId: task.id }));
    const openLink = async (url: string) => {
      try {
        await api.shell.openExternal(url);
      } catch {
        toastManager.add({ type: "error", title: "Could not open the link" });
      }
    };
    const memberAt = (prefix: string) => item.members[Number(id.slice(prefix.length))]?.view;
    if (id.startsWith("open-linked:")) {
      const sibling = linked[Number(id.slice("open-linked:".length))];
      const siblingView =
        sibling === undefined
          ? null
          : readWorkTaskView(workTaskKey(sibling.environmentId, sibling.id));
      if (siblingView === null) return;
      onNavigate?.();
      openWorkTask(siblingView);
      return;
    }
    if (id.startsWith("open-pr:")) {
      const url = memberAt("open-pr:")?.pullRequest?.url;
      if (url !== undefined) await openLink(url);
      return;
    }
    if (id.startsWith("new-thread:")) {
      const member = memberAt("new-thread:");
      if (member === undefined) return;
      onNavigate?.();
      await createWorkTaskThread(member.task);
      return;
    }
    switch (id) {
      case "open-ado":
        if (item.workItem?.url) await openLink(item.workItem.url);
        return;
      case "copy-id":
        if (item.workItem !== null) copyText(String(item.workItem.id), "Work item ID");
        return;
      case "copy-branch":
        copyText(latest.task.workspace.branch, "Branch name");
        return;
      case "rename":
        openRenameWorkTaskDialog({ refs, title: item.title });
        return;
      case "rename-ai":
        for (const ref of refs)
          await rename({ environmentId: ref.environmentId, input: { taskId: ref.taskId } });
        return;
      case "mark-waiting":
        openWaitingReasonDialog(refs);
        return;
      case "clear-waiting":
        for (const task of tasks) {
          if (task.waitingForUserReason === null) continue;
          await setWaiting({
            environmentId: task.environmentId,
            input: { taskId: task.id, reason: null },
          });
        }
        return;
      case "auto-handle": {
        const enabled = !tasks.every((task) => task.autoHandleReviewFeedback);
        for (const task of tasks) {
          await setAutoHandle({
            environmentId: task.environmentId,
            input: { taskId: task.id, enabled },
          });
        }
        return;
      }
      case "archive": {
        // One task keeps its dialog, which checks the worktree for blockers.
        if (refs.length === 1) {
          openArchiveWorkTaskDialog(refs[0]!);
          return;
        }
        const confirmed = await api.dialogs.confirm(
          `Archive ${item.title}? This archives its ${refs.length} Work Tasks, stops their agents and removes their worktrees, except any with uncommitted changes.`,
          { variant: "destructive" },
        );
        if (!confirmed) return;
        for (const task of tasks) {
          if (task.archivedAt !== null) continue;
          await archive({
            environmentId: task.environmentId,
            input: { taskId: task.id },
          });
        }
        return;
      }
    }
  };
}
