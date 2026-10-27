import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import { EnvironmentAuthorizationError } from "../auth.ts";
import {
  GitGraphCommitDiffInput,
  GitGraphCommitDiffResult,
  GitGraphError,
  GitGraphLogInput,
  GitGraphLogResult,
} from "./gitGraph.ts";
import {
  BranchWorkItems,
  BranchWorkItemsInput,
  CreateChildWorkItemInput,
  CreateChildWorkItemResult,
  LinkBranchWorkItemInput,
  UpdateWorkItemInput,
  WorkItemsError,
} from "./workItems.ts";

export * from "./gitGraph.ts";
export * from "./workItems.ts";

export const MERGE_WS_METHODS = {
  ping: "merge.ping",
  gitGraphLog: "merge.gitGraph.log",
  gitGraphCommitDiff: "merge.gitGraph.commitDiff",
  workItemsBranch: "merge.workItems.branch",
  workItemsLink: "merge.workItems.link",
  workItemsUpdate: "merge.workItems.update",
  workItemsCreateChild: "merge.workItems.createChild",
} as const;

export const MergePingRpc = Rpc.make(MERGE_WS_METHODS.ping, {
  payload: Schema.Struct({}),
  success: Schema.Struct({ pong: Schema.Literal(true) }),
  error: EnvironmentAuthorizationError,
});

export const MergeGitGraphLogRpc = Rpc.make(MERGE_WS_METHODS.gitGraphLog, {
  payload: GitGraphLogInput,
  success: GitGraphLogResult,
  error: GitGraphError,
});

export const MergeGitGraphCommitDiffRpc = Rpc.make(MERGE_WS_METHODS.gitGraphCommitDiff, {
  payload: GitGraphCommitDiffInput,
  success: GitGraphCommitDiffResult,
  error: GitGraphError,
});

export const MergeWorkItemsBranchRpc = Rpc.make(MERGE_WS_METHODS.workItemsBranch, {
  payload: BranchWorkItemsInput,
  success: BranchWorkItems,
  error: WorkItemsError,
});

export const MergeWorkItemsLinkRpc = Rpc.make(MERGE_WS_METHODS.workItemsLink, {
  payload: LinkBranchWorkItemInput,
  error: WorkItemsError,
});

export const MergeWorkItemsUpdateRpc = Rpc.make(MERGE_WS_METHODS.workItemsUpdate, {
  payload: UpdateWorkItemInput,
  error: WorkItemsError,
});

export const MergeWorkItemsCreateChildRpc = Rpc.make(MERGE_WS_METHODS.workItemsCreateChild, {
  payload: CreateChildWorkItemInput,
  success: CreateChildWorkItemResult,
  error: WorkItemsError,
});

/** Fork RPCs. Merged into `WsRpcGroup` at the `rpc-group` seam. */
export const MergeRpcGroup = RpcGroup.make(
  MergePingRpc,
  MergeGitGraphLogRpc,
  MergeGitGraphCommitDiffRpc,
  MergeWorkItemsBranchRpc,
  MergeWorkItemsLinkRpc,
  MergeWorkItemsUpdateRpc,
  MergeWorkItemsCreateChildRpc,
);
