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
  FolderAssignInput,
  FolderCreateInput,
  FolderCreateResult,
  FolderIdInput,
  FolderRenameInput,
  FoldersError,
  FoldersSnapshot,
} from "./folders.ts";
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

export * from "./folders.ts";
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
  foldersSubscribe: "merge.folders.subscribe",
  foldersCreate: "merge.folders.create",
  foldersRename: "merge.folders.rename",
  foldersDelete: "merge.folders.delete",
  foldersAssign: "merge.folders.assign",
} as const;

const MergePingRpc = Rpc.make(MERGE_WS_METHODS.ping, {
  payload: Schema.Struct({}),
  success: Schema.Struct({ pong: Schema.Literal(true) }),
  error: EnvironmentAuthorizationError,
});

const MergeGitGraphLogRpc = Rpc.make(MERGE_WS_METHODS.gitGraphLog, {
  payload: GitGraphLogInput,
  success: GitGraphLogResult,
  error: GitGraphError,
});

const MergeGitGraphCommitDiffRpc = Rpc.make(MERGE_WS_METHODS.gitGraphCommitDiff, {
  payload: GitGraphCommitDiffInput,
  success: GitGraphCommitDiffResult,
  error: GitGraphError,
});

const MergeWorkItemsBranchRpc = Rpc.make(MERGE_WS_METHODS.workItemsBranch, {
  payload: BranchWorkItemsInput,
  success: BranchWorkItems,
  error: WorkItemsError,
});

const MergeWorkItemsLinkRpc = Rpc.make(MERGE_WS_METHODS.workItemsLink, {
  payload: LinkBranchWorkItemInput,
  error: WorkItemsError,
});

const MergeWorkItemsUpdateRpc = Rpc.make(MERGE_WS_METHODS.workItemsUpdate, {
  payload: UpdateWorkItemInput,
  error: WorkItemsError,
});

const MergeWorkItemsCreateChildRpc = Rpc.make(MERGE_WS_METHODS.workItemsCreateChild, {
  payload: CreateChildWorkItemInput,
  success: CreateChildWorkItemResult,
  error: WorkItemsError,
});

const MergePullRequestsRequeueExpiredChecksRpc = Rpc.make(
  MERGE_WS_METHODS.pullRequestsRequeueExpiredChecks,
  {
    payload: RequeueExpiredChecksInput,
    success: RequeueExpiredChecksResult,
    error: RequeueExpiredChecksError,
  },
);

/** Every Work Task and thread link, then again after each change. */
const MergeWorkTasksSubscribeRpc = Rpc.make(MERGE_WS_METHODS.workTasksSubscribe, {
  payload: Schema.Struct({}),
  success: WorkTasksSnapshot,
  error: WorkTasksError,
  stream: true,
});

const MergeWorkTasksArchiveCheckRpc = Rpc.make(MERGE_WS_METHODS.workTasksArchiveCheck, {
  payload: WorkTaskIdInput,
  success: WorkTaskArchiveCheckResult,
  error: WorkTasksError,
});

const MergeWorkTasksCreateRpc = Rpc.make(MERGE_WS_METHODS.workTasksCreate, {
  payload: WorkTaskCreateInput,
  success: WorkTaskCreateResult,
  error: WorkTasksError,
});

const MergeWorkTasksRetrySetupRpc = Rpc.make(MERGE_WS_METHODS.workTasksRetrySetup, {
  payload: WorkTaskIdInput,
  error: WorkTasksError,
});

const MergeWorkTasksCreateThreadRpc = Rpc.make(MERGE_WS_METHODS.workTasksCreateThread, {
  payload: WorkTaskCreateThreadInput,
  success: WorkTaskCreateThreadResult,
  error: WorkTasksError,
});

const MergeWorkTasksArchiveRpc = Rpc.make(MERGE_WS_METHODS.workTasksArchive, {
  payload: WorkTaskArchiveInput,
  error: WorkTasksError,
});

const MergeWorkTasksSetWaitingRpc = Rpc.make(MERGE_WS_METHODS.workTasksSetWaiting, {
  payload: WorkTaskSetWaitingInput,
  error: WorkTasksError,
});

const MergeWorkTasksSetAutoHandleRpc = Rpc.make(MERGE_WS_METHODS.workTasksSetAutoHandle, {
  payload: WorkTaskSetAutoHandleInput,
  error: WorkTasksError,
});

const MergeWorkTasksListBranchesRpc = Rpc.make(MERGE_WS_METHODS.workTasksListBranches, {
  payload: WorkTaskListBranchesInput,
  success: VcsListRefsResult,
  error: WorkTasksError,
});

/** Every live folder and filed thread, then again after each change. */
const MergeFoldersSubscribeRpc = Rpc.make(MERGE_WS_METHODS.foldersSubscribe, {
  payload: Schema.Struct({}),
  success: FoldersSnapshot,
  error: FoldersError,
  stream: true,
});

const MergeFoldersCreateRpc = Rpc.make(MERGE_WS_METHODS.foldersCreate, {
  payload: FolderCreateInput,
  success: FolderCreateResult,
  error: FoldersError,
});

const MergeFoldersRenameRpc = Rpc.make(MERGE_WS_METHODS.foldersRename, {
  payload: FolderRenameInput,
  error: FoldersError,
});

/** Its threads move back to the thread list; none is deleted. */
const MergeFoldersDeleteRpc = Rpc.make(MERGE_WS_METHODS.foldersDelete, {
  payload: FolderIdInput,
  error: FoldersError,
});

const MergeFoldersAssignRpc = Rpc.make(MERGE_WS_METHODS.foldersAssign, {
  payload: FolderAssignInput,
  error: FoldersError,
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
  MergeFoldersSubscribeRpc,
  MergeFoldersCreateRpc,
  MergeFoldersRenameRpc,
  MergeFoldersDeleteRpc,
  MergeFoldersAssignRpc,
);
