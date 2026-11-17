import type {
  PullRequestActivity,
  PullRequestCheck,
  PullRequestDetail,
  PullRequestSummary,
  WorkTaskPullRequestFacts,
} from "@t3tools/contracts";

type Threads = Pick<PullRequestActivity, "reviewThreads" | "overviewThreads">;

/** Only required, non-placeholder checks count: optional failures never block the PR. */
export const rollupChecks = (
  checks: ReadonlyArray<PullRequestCheck>,
): WorkTaskPullRequestFacts["checks"] => {
  const required = checks.filter((c) => c.required === true && c.placeholder !== true);
  if (required.some((c) => c.status === "failure")) return "failing";
  // action-required waits on a person, so it is not passing yet.
  if (required.some((c) => c.status === "pending" || c.status === "action-required"))
    return "pending";
  return required.length > 0 ? "passing" : "none";
};

// Threads carry no system flag in the contract, so every unresolved thread counts.
export const countUnresolvedThreads = (activity: Threads): number =>
  [...activity.reviewThreads, ...(activity.overviewThreads ?? [])].filter((t) => !t.isResolved)
    .length;

/** Detail carries no review decision; the summary does (on Azure DevOps via the fork's provider). */
export const pullRequestFacts = (
  detail: PullRequestDetail,
  summary: Pick<PullRequestSummary, "reviewDecision">,
  activity: Threads,
  syncedAt: string,
): WorkTaskPullRequestFacts => ({
  number: detail.number,
  review:
    summary.reviewDecision === "review-required" ? "pending" : (summary.reviewDecision ?? "none"),
  checks: rollupChecks(detail.checks),
  mergeConflicts: detail.mergeability === "conflicting",
  unresolvedComments: countUnresolvedThreads(activity),
  syncedAt,
});
