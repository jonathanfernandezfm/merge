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
  RequeueExpiredChecksError,
  RequeueExpiredChecksInput,
  RequeueExpiredChecksResult,
} from "./pullRequests.ts";
import {
  BranchWorkItems,
  BranchWorkItemsInput,
  CreateChildWorkItemInput,
  CreateChildWorkItemResult,
  LinkBranchWorkItemInput,
  UpdateWorkItemInput,
  WorkItemsError,
} from "./workItems.ts";
import { VcsListRefsResult } from "../git.ts";
import {
  WorkTaskArchiveCheckResult,
  WorkTaskArchiveInput,
  WorkTaskCreateInput,
  WorkTaskCreateResult,
  WorkTaskCreateThreadInput,
  WorkTaskCreateThreadResult,
  WorkTaskIdInput,
  WorkTaskListBranchesInput,
  WorkTaskSetAutoHandleInput,
  WorkTaskSetWaitingInput,
  WorkTasksError,
  WorkTasksSnapshot,
} from "./workTasks.ts";

export * from "./gitGraph.ts";
export * from "./workItems.ts";
export * from "./pullRequests.ts";
export * from "./workTasks.ts";
export * from "./workTaskStatus.ts";

export const MERGE_WS_METHODS = {
  ping: "merge.ping",
  gitGraphLog: "merge.gitGraph.log",
  gitGraphCommitDiff: "merge.gitGraph.commitDiff",
  workItemsBranch: "merge.workItems.branch",
  workItemsLink: "merge.workItems.link",
  workItemsUpdate: "merge.workItems.update",
  workItemsCreateChild: "merge.workItems.createChild",
  pullRequestsRequeueExpiredChecks: "merge.pullRequests.requeueExpiredChecks",
  workTasksSubscribe: "merge.workTasks.subscribe",
  workTasksArchiveCheck: "merge.workTasks.archiveCheck",
  workTasksCreate: "merge.workTasks.create",
  workTasksRetrySetup: "merge.workTasks.retrySetup",
  workTasksCreateThread: "merge.workTasks.createThread",
  workTasksArchive: "merge.workTasks.archive",
  workTasksSetWaiting: "merge.workTasks.setWaiting",
  workTasksSetAutoHandle: "merge.workTasks.setAutoHandle",
  workTasksListBranches: "merge.workTasks.listBranches",
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

export const MergePullRequestsRequeueExpiredChecksRpc = Rpc.make(
  MERGE_WS_METHODS.pullRequestsRequeueExpiredChecks,
  {
    payload: RequeueExpiredChecksInput,
    success: RequeueExpiredChecksResult,
    error: RequeueExpiredChecksError,
  },
);

/** Every Work Task and thread link, then again after each change. */
export const MergeWorkTasksSubscribeRpc = Rpc.make(MERGE_WS_METHODS.workTasksSubscribe, {
  payload: Schema.Struct({}),
  success: WorkTasksSnapshot,
  error: WorkTasksError,
  stream: true,
});

export const MergeWorkTasksArchiveCheckRpc = Rpc.make(MERGE_WS_METHODS.workTasksArchiveCheck, {
  payload: WorkTaskIdInput,
  success: WorkTaskArchiveCheckResult,
  error: WorkTasksError,
});

export const MergeWorkTasksCreateRpc = Rpc.make(MERGE_WS_METHODS.workTasksCreate, {
  payload: WorkTaskCreateInput,
  success: WorkTaskCreateResult,
  error: WorkTasksError,
});

export const MergeWorkTasksRetrySetupRpc = Rpc.make(MERGE_WS_METHODS.workTasksRetrySetup, {
  payload: WorkTaskIdInput,
  error: WorkTasksError,
});

export const MergeWorkTasksCreateThreadRpc = Rpc.make(MERGE_WS_METHODS.workTasksCreateThread, {
  payload: WorkTaskCreateThreadInput,
  success: WorkTaskCreateThreadResult,
  error: WorkTasksError,
});

export const MergeWorkTasksArchiveRpc = Rpc.make(MERGE_WS_METHODS.workTasksArchive, {
  payload: WorkTaskArchiveInput,
  error: WorkTasksError,
});

export const MergeWorkTasksSetWaitingRpc = Rpc.make(MERGE_WS_METHODS.workTasksSetWaiting, {
  payload: WorkTaskSetWaitingInput,
  error: WorkTasksError,
});

export const MergeWorkTasksSetAutoHandleRpc = Rpc.make(MERGE_WS_METHODS.workTasksSetAutoHandle, {
  payload: WorkTaskSetAutoHandleInput,
  error: WorkTasksError,
});

export const MergeWorkTasksListBranchesRpc = Rpc.make(MERGE_WS_METHODS.workTasksListBranches, {
  payload: WorkTaskListBranchesInput,
  success: VcsListRefsResult,
  error: WorkTasksError,
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
  MergePullRequestsRequeueExpiredChecksRpc,
  MergeWorkTasksSubscribeRpc,
  MergeWorkTasksArchiveCheckRpc,
  MergeWorkTasksCreateRpc,
  MergeWorkTasksRetrySetupRpc,
  MergeWorkTasksCreateThreadRpc,
  MergeWorkTasksArchiveRpc,
  MergeWorkTasksSetWaitingRpc,
  MergeWorkTasksSetAutoHandleRpc,
  MergeWorkTasksListBranchesRpc,
);
