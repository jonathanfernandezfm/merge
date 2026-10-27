import type { EnvironmentId, WorkTaskId } from "@t3tools/contracts";
import { Link, Navigate } from "@tanstack/react-router";
import { MessageSquarePlusIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "~/components/ui/empty";
import { SidebarInset } from "~/components/ui/sidebar";
import { Spinner } from "~/components/ui/spinner";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "~/components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { isElectron } from "~/env";
import { useAllEnvironmentShellsBootstrapped } from "~/state/entities";
import { useCreateWorkTaskThread } from "./actions";
import { useWorkTaskView } from "./state";
import { WorkTaskChrome } from "./WorkTaskChrome";

/**
 * A Work Task's own address. It opens the task's most recently active thread and only renders
 * itself while the task has no live thread: during setup, or after its last tab was closed.
 */
export function WorkTaskPage({
  environmentId,
  taskId,
}: {
  environmentId: EnvironmentId;
  taskId: WorkTaskId;
}) {
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const view = useWorkTaskView(environmentId, taskId);
  const { createWorkTaskThread, pending } = useCreateWorkTaskThread();

  if (view?.latestThread) {
    return (
      <Navigate
        to="/$environmentId/$threadId"
        params={{ environmentId, threadId: view.latestThread.id }}
        replace
      />
    );
  }
  const task = view?.task ?? null;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <WorkspacePageHeader electron={isElectron} className="relative bg-background">
          <WorkspaceBreadcrumb ariaLabel="Work Task breadcrumb">
            <WorkspaceBreadcrumbItem>
              <Link to="/work-tasks" className="hover:text-foreground">
                Work Taskboard
              </Link>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">{task?.title ?? "Work Task"}</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        {view !== null ? <WorkTaskChrome view={view} activeThreadId={null} /> : null}
        <div className="flex min-h-0 flex-1 items-center justify-center">
          {task === null ? (
            bootstrapped ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>Work Task not found</EmptyTitle>
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
                    ? "This Work Task is archived. Its workspace was removed."
                    : "Start a thread to put an agent to work in this Work Task's workspace."}
                </EmptyDescription>
              </EmptyHeader>
              {task.archivedAt === null ? (
                <EmptyContent>
                  <Button
                    size="sm"
                    disabled={pending}
                    onClick={() => void createWorkTaskThread(task)}
                  >
                    {pending ? <Spinner /> : <MessageSquarePlusIcon />}
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
