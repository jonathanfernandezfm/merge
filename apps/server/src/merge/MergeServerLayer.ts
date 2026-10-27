import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as WorkTaskStore from "./workTasks/WorkTaskStore.ts";
import * as WorkTaskWorkspace from "./workTasks/WorkTaskWorkspace.ts";

/** Fork services. Merged into the runtime core at the `server-layer` seam. */
export const MergeServerLayer = WorkTaskWorkspace.layer.pipe(
  Layer.provide(ProjectionStore.layer),
  Layer.provideMerge(WorkTaskStore.layer),
);
