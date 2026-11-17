import type { OrchestrationV2ThreadShell } from "../orchestrationV2.ts";
import type { ThreadPullRequestLink, ThreadPullRequestSnapshot } from "../threadPullRequest.ts";
import type { WorkTaskPullRequestFacts } from "./workTaskInsights.ts";
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
  "merge-conflicts",
  "changes-requested",
  "unresolved-comments",
  "approved-checks-failing",
  "addressing-comments",
  "waiting-for-review",
  "approved",
  "merged",
  "archived",
] as const;
export type WorkTaskStatus = (typeof WORK_TASK_STATUSES)[number];

/** Statuses in `deriveWorkTaskStatus` rule order, which breaks ties between tasks in a section. */
export const WORK_TASK_STATUS_URGENCY: ReadonlyArray<WorkTaskStatus> = [
  "archived",
  "setting-up",
  "setup-failed",
  "waiting-for-user",
  "addressing-comments",
  "merged",
  "merge-conflicts",
  "changes-requested",
  "unresolved-comments",
  "approved-checks-failing",
  "working",
  "monitoring",
  "approved",
  "waiting-for-review",
  "idle",
];

/** Who has the ball: the user (`attention`, no header), an agent, reviewers, or nobody. */
export type WorkTaskSection = "attention" | "working" | "review" | "done";

export function workTaskSection(status: WorkTaskStatus, unseen: boolean): WorkTaskSection {
  switch (status) {
    case "setting-up":
    case "working":
    case "addressing-comments":
    case "monitoring":
      return "working";
    case "waiting-for-review":
    case "approved":
      return unseen ? "attention" : "review";
    case "merged":
    case "archived":
      return unseen ? "attention" : "done";
    default:
      return "attention";
  }
}

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
  readonly mergeConflicts: boolean;
  readonly unresolvedComments: number;
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
  const live = shell.activeRunId !== null || LIVE_RUN_STATUSES.has(shell.status);
  const request = shell.pendingRuntimeRequest;
  // Same rule as client-runtime `hasPendingUserInput`: a non-blocking question while the run works is not a wait.
  if (request !== null && !(request.kind === "user_input" && request.blocking === false && live)) {
    return "waiting";
  }
  if (live) return "running";
  if ((shell.pendingBackgroundTasks?.length ?? 0) > 0) return "monitoring";
  return shell.latestRunId === null ? "new" : "idle";
}

/** `facts` (the fork's per-PR cache) override the snapshot's review and checks. */
export function workTaskPullRequestFromSnapshot(
  snapshot: ThreadPullRequestSnapshot,
  facts: WorkTaskPullRequestFacts | null,
): WorkTaskPullRequestView {
  const review = snapshot.reviewDecision ?? null;
  return {
    state: snapshot.state === "open" && snapshot.isDraft ? "draft" : snapshot.state,
    checks: facts?.checks ?? snapshot.checksState ?? "none",
    review:
      facts?.review ??
      (review === null ? "none" : review === "review-required" ? "pending" : review),
    mergeConflicts: snapshot.mergeability === "conflicting" || (facts?.mergeConflicts ?? false),
    unresolvedComments: facts?.unresolvedComments ?? 0,
  };
}

interface WorkTaskMembersInput {
  readonly taskId: WorkTaskId;
  readonly task: { readonly workspace: { readonly branch: string } };
  readonly links: ReadonlyArray<WorkTaskLink>;
  readonly shells: ReadonlyArray<WorkTaskStatusShell>;
}

/** Linked threads plus their subagent descendants, each with its root's origin. */
function workTaskMembers(input: WorkTaskMembersInput) {
  const origins = new Map(
    input.links
      .filter((link) => link.taskId === input.taskId)
      .map((link) => [link.threadId as string, link.origin] as const),
  );
  // Forks share rootThreadId and copy pullRequests too, so only subagent descendants join.
  const rootOf = (shell: WorkTaskStatusShell) =>
    origins.has(shell.id)
      ? shell.id
      : shell.lineage.relationshipToParent === "subagent" && origins.has(shell.lineage.rootThreadId)
        ? shell.lineage.rootThreadId
        : null;
  return input.shells.flatMap((shell) => {
    const root = rootOf(shell);
    return root === null ? [] : [{ shell, origin: origins.get(root) ?? null }];
  });
}

const newestBranchPullRequest = (
  shells: ReadonlyArray<WorkTaskStatusShell>,
  branch: string,
): ThreadPullRequestLink | undefined =>
  shells
    .flatMap((shell) => shell.pullRequests ?? [])
    .filter((link) => link.snapshot?.headBranch === branch)
    .sort((a, b) => b.linkedAt.localeCompare(a.linkedAt))[0];

/** The task's pull request link: the most recently linked snapshot on the task branch. */
export function workTaskPullRequestLink(
  input: WorkTaskMembersInput,
): ThreadPullRequestLink | undefined {
  return newestBranchPullRequest(
    workTaskMembers(input).map((member) => member.shell),
    input.task.workspace.branch,
  );
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
  readonly facts?: WorkTaskPullRequestFacts | null;
}): {
  readonly threads: ReadonlyArray<WorkTaskStatusThread>;
  readonly pullRequest: WorkTaskPullRequestView | null;
} {
  const members = workTaskMembers(input);
  const threads = members.map(({ shell, origin }) => ({
    origin,
    state: workTaskThreadState(shell),
  }));
  const snapshot = newestBranchPullRequest(
    members.map((member) => member.shell),
    input.task.workspace.branch,
  )?.snapshot;
  const legacy = input.task.legacyPullRequest;
  return {
    threads,
    pullRequest: snapshot
      ? workTaskPullRequestFromSnapshot(snapshot, input.facts ?? null)
      : legacy
        ? legacyPullRequestView(legacy)
        : null,
  };
}

/** The legacy row knows nothing of conflicts or comments. */
function legacyPullRequestView(
  legacy: NonNullable<WorkTaskStatusTask["legacyPullRequest"]>,
): WorkTaskPullRequestView {
  return {
    state: legacy.state,
    checks: legacy.checks,
    review: legacy.review,
    mergeConflicts: false,
    unresolvedComments: 0,
  };
}

/**
 * The single place a Work Task's status is decided: who has the ball. The first matching rule
 * wins, in `WORK_TASK_STATUS_URGENCY` order. Failing checks count only on an approved PR, so
 * expired checks make no noise.
 */
export function deriveWorkTaskStatus(input: {
  readonly task: WorkTaskStatusTask;
  readonly threads: ReadonlyArray<WorkTaskStatusThread>;
  readonly pullRequest: WorkTaskPullRequestView | null;
}): WorkTaskStatus {
  const { task, threads, pullRequest } = input;
  const running = threads.some((thread) => thread.state === "running");
  const monitoring = threads.some((thread) => thread.state === "monitoring");

  if (task.archivedAt !== null) return "archived";

  const setup = task.workspace.setup.status;
  if (setup === "pending" || setup === "running") return "setting-up";
  if (setup === "failed") return "setup-failed";

  if (task.waitingForUserReason !== null || threads.some((thread) => thread.state === "waiting")) {
    return "waiting-for-user";
  }
  if (threads.some((thread) => thread.state === "running" && thread.origin === "review-feedback")) {
    return "addressing-comments";
  }
  if (task.mergedAt !== null || pullRequest?.state === "merged") {
    return running || monitoring ? "monitoring" : "merged";
  }

  // A closed pull request no longer gates anything; the task is back to no PR.
  const open =
    pullRequest !== null && (pullRequest.state === "open" || pullRequest.state === "draft")
      ? pullRequest
      : null;
  if (open !== null) {
    if (open.mergeConflicts) return "merge-conflicts";
    if (open.review === "changes-requested") return "changes-requested";
    if (open.unresolvedComments > 0) return "unresolved-comments";
    if (open.review === "approved" && open.checks === "failing") return "approved-checks-failing";
  }
  if (running) return "working";
  if (monitoring) return "monitoring";

  if (open?.state === "open") return open.review === "approved" ? "approved" : "waiting-for-review";
  return "idle";
}
