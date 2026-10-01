import { latestTaskThread } from "@t3tools/client-runtime/state/tasks";
import type { EnvironmentId, TaskId } from "@t3tools/contracts";
import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { MessageSquarePlusIcon } from "lucide-react";
import { useMemo } from "react";

import { TaskWorkspaceChrome, useCreateTaskThread } from "../components/task/TaskWorkspaceBar";
import { Button } from "../components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../components/ui/empty";
import { Spinner } from "../components/ui/spinner";
import { SidebarInset } from "../components/ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { useAllEnvironmentShellsBootstrapped } from "../state/entities";
import { useTask, useTaskThreadShells } from "../state/tasks";

/**
 * A task's own address. It opens the task's most recently active thread, and
 * only renders itself while the task has no live thread: during setup, or
 * after its last tab was closed.
 */
function TaskRouteView() {
  const params = Route.useParams();
  const environmentId = params.environmentId as EnvironmentId;
  const taskId = params.taskId as TaskId;
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const task = useTask(environmentId, taskId);
  const taskRef = useMemo(() => ({ environmentId, taskId }), [environmentId, taskId]);
  const threads = useTaskThreadShells(taskRef);
  const latest = latestTaskThread(threads);
  const { createTaskThread, pending: creatingThread } = useCreateTaskThread();

  if (latest !== null) {
    return (
      <Navigate
        to="/$environmentId/$threadId"
        params={{ environmentId, threadId: latest.id }}
        replace
      />
    );
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <WorkspacePageHeader electron={isElectron} className="relative bg-background">
          <WorkspaceBreadcrumb ariaLabel="Task breadcrumb">
            <WorkspaceBreadcrumbItem>
              <Link to="/taskboard" className="hover:text-foreground">
                Taskboard
              </Link>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">{task?.title ?? "Task"}</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        {task !== null ? (
          <TaskWorkspaceChrome task={task} activeThreadId={null} showTitle={false} />
        ) : null}
        <div className="flex min-h-0 flex-1 items-center justify-center">
          {task === null ? (
            bootstrapped ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>Task not found</EmptyTitle>
                  <EmptyDescription>
                    It may belong to an environment that is not connected.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : null
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No open threads</EmptyTitle>
                <EmptyDescription>
                  {task.archivedAt !== null
                    ? "This task is archived. Its workspace was removed."
                    : "Start a thread to put an agent to work in this task's workspace."}
                </EmptyDescription>
              </EmptyHeader>
              {task.archivedAt === null ? (
                <EmptyContent>
                  <Button
                    size="sm"
                    disabled={creatingThread}
                    onClick={() => void createTaskThread(task)}
                  >
                    {creatingThread ? <Spinner /> : <MessageSquarePlusIcon />}
                    New thread
                  </Button>
                </EmptyContent>
              ) : null}
            </Empty>
          )}
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/tasks/$environmentId/$taskId")({
  component: TaskRouteView,
});
