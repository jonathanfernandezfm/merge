import * as Layer from "effect/Layer";

/** Fork services. Merged into the runtime core at the `server-layer` seam. Add `Layer.mergeAll(...)` once there are services. */
export const MergeServerLayer = Layer.empty;
