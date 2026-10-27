import {
  AuthFilesystemReadScope,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  MERGE_WS_METHODS,
  MergeRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { requeueExpiredChecks } from "../azureDevOps/requeueExpiredChecks.ts";
import { gitGraphCommitDiff, gitGraphLog } from "../gitGraph/gitGraph.ts";
import {
  branchWorkItems,
  createChildWorkItem,
  linkBranchWorkItem,
  updateWorkItem,
} from "../workItems/workItems.ts";

/** Spread into the WS handler map at the `rpc-group-handlers` seam. */
export const mergeRpcHandlers = MergeRpcGroup.of({
  [MERGE_WS_METHODS.ping]: () => Effect.succeed({ pong: true as const }),
  [MERGE_WS_METHODS.gitGraphLog]: gitGraphLog,
  [MERGE_WS_METHODS.gitGraphCommitDiff]: gitGraphCommitDiff,
  [MERGE_WS_METHODS.workItemsBranch]: branchWorkItems,
  [MERGE_WS_METHODS.workItemsLink]: linkBranchWorkItem,
  [MERGE_WS_METHODS.workItemsUpdate]: updateWorkItem,
  [MERGE_WS_METHODS.workItemsCreateChild]: createChildWorkItem,
  [MERGE_WS_METHODS.pullRequestsRequeueExpiredChecks]: requeueExpiredChecks,
});

/** Spread into `RPC_REQUIRED_SCOPES` at the `rpc-group-scopes` seam. */
export const MERGE_RPC_REQUIRED_SCOPES = {
  [MERGE_WS_METHODS.ping]: AuthOrchestrationReadScope,
  // Same scope as upstream's review.getDiffPreview.
  [MERGE_WS_METHODS.gitGraphLog]: AuthFilesystemReadScope,
  [MERGE_WS_METHODS.gitGraphCommitDiff]: AuthFilesystemReadScope,
  // Same scopes upstream gives source-control lookups and writes.
  [MERGE_WS_METHODS.workItemsBranch]: AuthOrchestrationReadScope,
  [MERGE_WS_METHODS.workItemsLink]: AuthSourceControlWriteScope,
  [MERGE_WS_METHODS.workItemsUpdate]: AuthSourceControlWriteScope,
  [MERGE_WS_METHODS.workItemsCreateChild]: AuthSourceControlWriteScope,
  // Same scope as upstream's pull request actions.
  [MERGE_WS_METHODS.pullRequestsRequeueExpiredChecks]: AuthSourceControlWriteScope,
} as const;

/** Spread into `RPC_AGGREGATES` at the `rpc-group-aggregates` seam. */
export const MERGE_RPC_AGGREGATES = {
  [MERGE_WS_METHODS.ping]: "merge",
  [MERGE_WS_METHODS.gitGraphLog]: "merge",
  [MERGE_WS_METHODS.gitGraphCommitDiff]: "merge",
  [MERGE_WS_METHODS.workItemsBranch]: "merge",
  [MERGE_WS_METHODS.workItemsLink]: "merge",
  [MERGE_WS_METHODS.workItemsUpdate]: "merge",
  [MERGE_WS_METHODS.workItemsCreateChild]: "merge",
  [MERGE_WS_METHODS.pullRequestsRequeueExpiredChecks]: "merge",
} as const;
