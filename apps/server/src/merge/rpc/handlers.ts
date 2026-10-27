import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  MERGE_WS_METHODS,
  MergeRpcGroup,
  type WorkTaskId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { requeueExpiredChecks } from "../azureDevOps/requeueExpiredChecks.ts";
import { gitGraphCommitDiff, gitGraphLog } from "../gitGraph/gitGraph.ts";
import {
  branchWorkItems,
  createChildWorkItem,
  linkBranchWorkItem,
  updateWorkItem,
} from "../workItems/workItems.ts";
import { lookup } from "../workspaceGuard.ts";
import { WorkTaskStore } from "../workTasks/WorkTaskStore.ts";
import { WorkTaskWorkspace } from "../workTasks/WorkTaskWorkspace.ts";

const workTasksSubscribe = () =>
  Stream.unwrap(
    Effect.gen(function* () {
      const store = yield* lookup(WorkTaskStore);
      return store.changes.pipe(
        Stream.mapEffect(() => Effect.all({ tasks: store.list(), links: store.links() })),
      );
    }),
  );

const workTasksArchiveCheck = Effect.fn("MergeRpc.workTasksArchiveCheck")(function* (input: {
  readonly taskId: WorkTaskId;
}) {
  const workspace = yield* lookup(WorkTaskWorkspace);
  return yield* workspace.archiveCheck(input.taskId);
});

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
  [MERGE_WS_METHODS.workTasksSubscribe]: workTasksSubscribe,
  [MERGE_WS_METHODS.workTasksArchiveCheck]: workTasksArchiveCheck,
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
  // Same scope as upstream's orchestration shell subscriptions.
  [MERGE_WS_METHODS.workTasksSubscribe]: AuthOrchestrationReadScope,
  // v0.0.10 gave task.archiveCheck the operate scope, next to the archive it guards.
  [MERGE_WS_METHODS.workTasksArchiveCheck]: AuthOrchestrationOperateScope,
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
  [MERGE_WS_METHODS.workTasksSubscribe]: "merge",
  [MERGE_WS_METHODS.workTasksArchiveCheck]: "merge",
} as const;
