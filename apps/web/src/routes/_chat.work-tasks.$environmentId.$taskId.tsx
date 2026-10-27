// merge-seam: routes
import type { EnvironmentId, WorkTaskId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { WorkTaskPage } from "../merge/workTasks/WorkTaskPage";

function WorkTaskRouteView() {
  const params = Route.useParams();
  return (
    <WorkTaskPage
      environmentId={params.environmentId as EnvironmentId}
      taskId={params.taskId as WorkTaskId}
    />
  );
}

export const Route = createFileRoute("/_chat/work-tasks/$environmentId/$taskId")({
  component: WorkTaskRouteView,
});
