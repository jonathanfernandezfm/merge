import {
  AuthFilesystemReadScope,
  AuthOrchestrationReadScope,
  MERGE_WS_METHODS,
  MergeRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { gitGraphCommitDiff, gitGraphLog } from "../gitGraph/gitGraph.ts";

/** Spread into the WS handler map at the `rpc-group-handlers` seam. */
export const mergeRpcHandlers = MergeRpcGroup.of({
  [MERGE_WS_METHODS.ping]: () => Effect.succeed({ pong: true as const }),
  [MERGE_WS_METHODS.gitGraphLog]: gitGraphLog,
  [MERGE_WS_METHODS.gitGraphCommitDiff]: gitGraphCommitDiff,
});

/** Spread into `RPC_REQUIRED_SCOPES` at the `rpc-group-scopes` seam. */
export const MERGE_RPC_REQUIRED_SCOPES = {
  [MERGE_WS_METHODS.ping]: AuthOrchestrationReadScope,
  // Same scope as upstream's review.getDiffPreview.
  [MERGE_WS_METHODS.gitGraphLog]: AuthFilesystemReadScope,
  [MERGE_WS_METHODS.gitGraphCommitDiff]: AuthFilesystemReadScope,
} as const;

/** Spread into `RPC_AGGREGATES` at the `rpc-group-aggregates` seam. */
export const MERGE_RPC_AGGREGATES = {
  [MERGE_WS_METHODS.ping]: "merge",
  [MERGE_WS_METHODS.gitGraphLog]: "merge",
  [MERGE_WS_METHODS.gitGraphCommitDiff]: "merge",
} as const;
