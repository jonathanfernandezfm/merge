import type { OrchestrationV2ThreadShell } from "../orchestrationV2.ts";
import type { ThreadPullRequestSnapshot } from "../threadPullRequest.ts";
import type {
  WorkTask,
  WorkTaskChecksState,
  WorkTaskId,
  WorkTaskLink,
  WorkTaskPullRequestState,
  WorkTaskReviewState,
  WorkTaskThreadOrigin,
} from "./workTasks.ts";

export const WORK_TASK_STATUSES = [
  "setting-up",
  "setup-failed",
  "working",
  "monitoring",
  "waiting-for-user",
  "idle",
  "ci-running",
  "ci-failing",
  "changes-requested",
  "addressing-comments",
  "waiting-for-review",
  "approved",
  "merge-ready",
  "merged",
  "archived",
] as const;
export type WorkTaskStatus = (typeof WORK_TASK_STATUSES)[number];

/**
 * What a Work Task thread is doing: `waiting` while it blocks on the user, `running` while a run
 * is live, `monitoring` while only background work outlives the run, `idle` once it has run, `new`
 * before its first run.
 */
export type WorkTaskThreadState = "running" | "waiting" | "monitoring" | "idle" | "new";

export interface WorkTaskStatusThread {
  readonly origin: WorkTaskThreadOrigin | null;
  readonly state: WorkTaskThreadState;
}

/** The pull request facts status needs, from a thread link snapshot or the legacy task row. */
export interface WorkTaskPullRequestView {
  readonly state: WorkTaskPullRequestState;
  readonly checks: WorkTaskChecksState;
  readonly review: WorkTaskReviewState;
}

export type WorkTaskStatusTask = Pick<
  WorkTask,
  "archivedAt" | "mergedAt" | "waitingForUserReason" | "legacyPullRequest"
> & {
  readonly workspace: {
    readonly branch: string;
    readonly setup: Pick<WorkTask["workspace"]["setup"], "status">;
  };
};

export type WorkTaskStatusShell = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "lineage"
  | "latestRunId"
  | "activeRunId"
  | "status"
  | "pendingRuntimeRequest"
  | "pendingBackgroundTasks"
  | "pullRequests"
>;

const LIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2ThreadShell["status"]> = new Set([
  "queued",
  "preparing",
  "starting",
  "running",
  "waiting",
]);

export function workTaskThreadState(shell: WorkTaskStatusShell): WorkTaskThreadState {
  if (shell.pendingRuntimeRequest !== null) return "waiting";
  if (shell.activeRunId !== null || LIVE_RUN_STATUSES.has(shell.status)) return "running";
  if ((shell.pendingBackgroundTasks?.length ?? 0) > 0) return "monitoring";
  return shell.latestRunId === null ? "new" : "idle";
}

export function workTaskPullRequestFromSnapshot(
  snapshot: ThreadPullRequestSnapshot,
): WorkTaskPullRequestView {
  const review = snapshot.reviewDecision ?? null;
  return {
    state: snapshot.state === "open" && snapshot.isDraft ? "draft" : snapshot.state,
    checks: snapshot.checksState ?? "none",
    review: review === null ? "none" : review === "review-required" ? "pending" : review,
  };
}

/**
 * The task's threads (linked ones plus their subagent descendants, which carry the root's origin)
 * and its pull request: the most recently linked snapshot on the task branch, else the legacy row.
 */
export function workTaskStatusInputs(input: {
  readonly taskId: WorkTaskId;
  readonly task: WorkTaskStatusTask;
  readonly links: ReadonlyArray<WorkTaskLink>;
  readonly shells: ReadonlyArray<WorkTaskStatusShell>;
}): {
  readonly threads: ReadonlyArray<WorkTaskStatusThread>;
  readonly pullRequest: WorkTaskPullRequestView | null;
} {
  const origins = new Map(
    input.links
      .filter((link) => link.taskId === input.taskId)
      .map((link) => [link.threadId as string, link.origin] as const),
  );
  const members = input.shells.filter(
    (shell) => origins.has(shell.id) || origins.has(shell.lineage.rootThreadId),
  );
  const threads = members.map((shell) => ({
    origin: origins.get(shell.id) ?? origins.get(shell.lineage.rootThreadId) ?? null,
    state: workTaskThreadState(shell),
  }));
  const snapshot = members
    .flatMap((shell) => shell.pullRequests ?? [])
    .filter((link) => link.snapshot?.headBranch === input.task.workspace.branch)
    .sort((a, b) => b.linkedAt.localeCompare(a.linkedAt))[0]?.snapshot;
  return {
    threads,
    pullRequest: snapshot
      ? workTaskPullRequestFromSnapshot(snapshot)
      : (input.task.legacyPullRequest ?? null),
  };
}

/**
 * The single place a Work Task's status is decided. The first matching rule wins: archived,
 * merged, setup, waiting on the user, automated review work, failing checks, requested changes,
 * running agents, watch loops, approval, pending checks, an open pull request, then idle.
 */
export function deriveWorkTaskStatus(input: {
  readonly task: WorkTaskStatusTask;
  readonly threads: ReadonlyArray<WorkTaskStatusThread>;
  readonly pullRequest: WorkTaskPullRequestView | null;
}): WorkTaskStatus {
  const { task, threads, pullRequest } = input;

  if (task.archivedAt !== null) return "archived";
  if (task.mergedAt !== null || pullRequest?.state === "merged") return "merged";

  const setup = task.workspace.setup.status;
  if (setup === "pending" || setup === "running") return "setting-up";
  if (setup === "failed") return "setup-failed";

  if (task.waitingForUserReason !== null || threads.some((thread) => thread.state === "waiting")) {
    return "waiting-for-user";
  }
  if (threads.some((thread) => thread.state === "running" && thread.origin === "review-feedback")) {
    return "addressing-comments";
  }

  // A closed pull request no longer gates anything; the task is back to no PR.
  const open =
    pullRequest !== null && (pullRequest.state === "open" || pullRequest.state === "draft")
      ? pullRequest
      : null;
  if (open?.checks === "failing") return "ci-failing";
  if (open?.review === "changes-requested") return "changes-requested";
  if (threads.some((thread) => thread.state === "running")) return "working";
  if (threads.some((thread) => thread.state === "monitoring")) return "monitoring";

  if (open !== null) {
    if (open.review === "approved") {
      // A repository without checks has nothing left to wait for.
      return open.checks === "pending" ? "approved" : "merge-ready";
    }
    if (open.checks === "pending") return "ci-running";
    return "waiting-for-review";
  }
  return "idle";
}
