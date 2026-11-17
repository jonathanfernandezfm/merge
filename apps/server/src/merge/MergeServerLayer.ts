import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as FolderStore from "./folders/FolderStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as WorkTaskInsights from "./workTasks/WorkTaskInsights.ts";
import * as WorkTaskReactor from "./workTasks/WorkTaskReactor.ts";
import * as WorkTaskNaming from "./workTasks/WorkTaskNaming.ts";
import * as WorkTaskStore from "./workTasks/WorkTaskStore.ts";
import * as WorkTaskWorkspace from "./workTasks/WorkTaskWorkspace.ts";

// Workspace -> Naming -> Insights -> Store: Insights sits below Workspace so there is no cycle.
const layerWorkTaskServices = WorkTaskWorkspace.layer.pipe(
  Layer.provideMerge(WorkTaskNaming.layer),
  Layer.provide(ProjectionStore.layer),
  Layer.provideMerge(WorkTaskInsights.layer),
  Layer.provideMerge(WorkTaskStore.layer),
);

/**
 * Fork services and workers. Merged into the runtime core at the `server-layer` seam, which
 * provides upstream's shared PullRequestService.
 */
export const MergeServerLayer = Layer.effectDiscard(
  Effect.all([
    Effect.flatMap(WorkTaskReactor.WorkTaskReactor, (reactor) => reactor.start()),
    Effect.flatMap(WorkTaskInsights.WorkTaskInsights, (insights) => insights.start()),
  ]),
).pipe(
  Layer.provide(WorkTaskReactor.layer),
  Layer.provideMerge(layerWorkTaskServices),
  Layer.provideMerge(FolderStore.layer),
  Layer.provide(ProjectionStore.layer),
);
