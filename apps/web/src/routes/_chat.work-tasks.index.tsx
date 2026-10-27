// merge-seam: routes
import { createFileRoute } from "@tanstack/react-router";

import { WorkTaskboard } from "../merge/workTasks/WorkTaskboard";

export const Route = createFileRoute("/_chat/work-tasks/")({
  component: WorkTaskboard,
});
