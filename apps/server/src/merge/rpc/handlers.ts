import { AuthOrchestrationReadScope, MERGE_WS_METHODS, MergeRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

/** Spread into the WS handler map at the `rpc-group-handlers` seam. */
export const mergeRpcHandlers = MergeRpcGroup.of({
  [MERGE_WS_METHODS.ping]: () => Effect.succeed({ pong: true as const }),
});

/** Spread into `RPC_REQUIRED_SCOPES` at the `rpc-group-scopes` seam. */
export const MERGE_RPC_REQUIRED_SCOPES = {
  [MERGE_WS_METHODS.ping]: AuthOrchestrationReadScope,
} as const;

/** Spread into `RPC_AGGREGATES` at the `rpc-group-aggregates` seam. */
export const MERGE_RPC_AGGREGATES = {
  [MERGE_WS_METHODS.ping]: "merge",
} as const;
