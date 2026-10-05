import type { OrchestrationTask, ThreadOrigin } from "@t3tools/contracts";

export const TASK_STATUSES = [
  "setting-up",
  "setup-failed",
  "working",
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
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * What a task thread is doing, mapped by the caller from its shell:
 * `running` while a turn runs, `waiting` while it blocks on the user
 * (pending approval or input), `idle` once it has run at least one turn,
 * `new` before its first turn.
 */
export type TaskThreadState = "running" | "waiting" | "idle" | "new";

export interface TaskStatusThread {
  readonly origin: ThreadOrigin | null | undefined;
  readonly state: TaskThreadState;
}

export type TaskStatusTask = Pick<
  OrchestrationTask,
  "archivedAt" | "mergedAt" | "waitingForUserReason" | "pullRequest"
> & {
  readonly workspace: { readonly setup: Pick<OrchestrationTask["workspace"]["setup"], "status"> };
};

/**
 * The single place a task's status is decided (spec §22). The first matching
 * rule wins: archived, merged, setup, waiting on the user, automated review
 * work, failing checks, requested changes, running agents, approval, pending
 * checks, an open pull request, and finally no pull request.
 */
export function deriveTaskStatus(input: {
  readonly task: TaskStatusTask;
  readonly threads: ReadonlyArray<TaskStatusThread>;
}): TaskStatus {
  const { task, threads } = input;
  const pullRequest = task.pullRequest;

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
  const openPullRequest =
    pullRequest !== null && (pullRequest.state === "open" || pullRequest.state === "draft")
      ? pullRequest
      : null;
  if (openPullRequest?.checks === "failing") return "ci-failing";
  if (openPullRequest?.review === "changes-requested") return "changes-requested";
  if (threads.some((thread) => thread.state === "running")) return "working";

  if (openPullRequest !== null) {
    if (openPullRequest.review === "approved") {
      // A repository without checks has nothing left to wait for.
      return openPullRequest.checks === "pending" ? "approved" : "merge-ready";
    }
    if (openPullRequest.checks === "pending") return "ci-running";
    return "waiting-for-review";
  }

  // No pull request and nothing running: the task idles until someone picks it
  // up again, including a task with no threads or only fresh ones.
  return "idle";
}

export type TaskStatusTone = "neutral" | "info" | "success" | "warning" | "danger";

/**
 * A status ring. `dashed` while an agent or CI works in the background,
 * `solid` while the task rests at a stage, `filled` when it needs a look or
 * is done. The pie inside a ring grows with the task's lifecycle.
 */
export interface StatusGlyph {
  readonly ring: "dashed" | "solid" | "filled";
  readonly progress: 0 | 0.25 | 0.5 | 0.75 | 1;
  readonly mark: "none" | "x" | "check" | "alert" | "minus";
}

export interface TaskStatusPresentation {
  readonly label: string;
  /** Distinct per status, so a status never depends on color alone. */
  readonly glyph: StatusGlyph;
  readonly tone: TaskStatusTone;
}

const glyph = (
  ring: StatusGlyph["ring"],
  progress: StatusGlyph["progress"] = 0,
  mark: StatusGlyph["mark"] = "none",
): StatusGlyph => ({ ring, progress, mark });

export const TASK_STATUS_PRESENTATION: Readonly<Record<TaskStatus, TaskStatusPresentation>> = {
  "setting-up": { label: "Setting up", glyph: glyph("dashed"), tone: "info" },
  "setup-failed": { label: "Setup failed", glyph: glyph("dashed", 0, "x"), tone: "danger" },
  working: { label: "Working", glyph: glyph("dashed", 0.25), tone: "info" },
  "waiting-for-user": { label: "Needs you", glyph: glyph("filled", 0, "alert"), tone: "warning" },
  idle: { label: "Idle", glyph: glyph("solid", 0.5), tone: "neutral" },
  "ci-running": { label: "Checks running", glyph: glyph("dashed", 0.5), tone: "info" },
  "ci-failing": { label: "Checks failing", glyph: glyph("filled", 0, "x"), tone: "danger" },
  "changes-requested": {
    label: "Changes requested",
    glyph: glyph("solid", 0, "alert"),
    tone: "warning",
  },
  "addressing-comments": {
    label: "Addressing comments",
    glyph: glyph("dashed", 0.75),
    tone: "info",
  },
  "waiting-for-review": { label: "In review", glyph: glyph("solid", 0.75), tone: "neutral" },
  approved: { label: "Approved", glyph: glyph("solid", 1), tone: "success" },
  "merge-ready": { label: "Ready to merge", glyph: glyph("solid", 0, "check"), tone: "success" },
  merged: { label: "Merged", glyph: glyph("filled", 0, "check"), tone: "success" },
  archived: { label: "Archived", glyph: glyph("solid", 0, "minus"), tone: "neutral" },
};
