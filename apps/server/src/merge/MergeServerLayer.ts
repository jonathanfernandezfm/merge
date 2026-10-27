import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as FolderStore from "./folders/FolderStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as WorkTaskReactor from "./workTasks/WorkTaskReactor.ts";
import * as WorkTaskStore from "./workTasks/WorkTaskStore.ts";
import * as WorkTaskWorkspace from "./workTasks/WorkTaskWorkspace.ts";

const layerWorkTaskServices = WorkTaskWorkspace.layer.pipe(
  Layer.provide(ProjectionStore.layer),
  Layer.provideMerge(WorkTaskStore.layer),
);

/** Fork services and workers. Merged into the runtime core at the `server-layer` seam. */
export const MergeServerLayer = Layer.effectDiscard(
  Effect.flatMap(WorkTaskReactor.WorkTaskReactor, (reactor) => reactor.start()),
).pipe(
  Layer.provide(WorkTaskReactor.layer),
  Layer.provideMerge(layerWorkTaskServices),
  Layer.provideMerge(FolderStore.layer),
  Layer.provide(ProjectionStore.layer),
);
