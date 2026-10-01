/**
 * Provider-independent workspace events for a task's pull request, and the
 * pure normalizer that derives them from two observations of the host.
 *
 * The supervisor stores every event in the `task_scm_events` ledger under its
 * `key`. Keys are deterministic, so observing the same host state twice
 * produces the same keys and the ledger ignores the repeat.
 *
 * @module taskWorkspaceEvents
 */
import type {
  OrchestrationTaskChecksState,
  OrchestrationTaskPullRequest,
  OrchestrationTaskPullRequestState,
  OrchestrationTaskReviewState,
  PullRequestActivity,
  PullRequestCheck,
  PullRequestChecksState,
  PullRequestComment,
  PullRequestDetail,
  PullRequestReviewDecision,
  PullRequestReviewThread,
  PullRequestSummary,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export type TaskWorkspaceEventType =
  | "pull-request-discovered"
  | "pull-request-updated"
  | "pull-request-merged"
  | "review-comment-added"
  | "review-changes-requested"
  | "review-approved"
  | "checks-started"
  | "checks-failed"
  | "checks-passed";

/** What an automated thread needs to know about one review comment. */
export const ReviewCommentPayload = Schema.Struct({
  commentId: Schema.String,
  reviewThreadId: Schema.NullOr(Schema.String),
  author: Schema.NullOr(Schema.String),
  body: Schema.String,
  path: Schema.NullOr(Schema.String),
  line: Schema.NullOr(Schema.Number),
  url: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type ReviewCommentPayload = typeof ReviewCommentPayload.Type;

export interface PullRequestEventPayload {
  readonly number: number;
  readonly url: string;
  readonly state: OrchestrationTaskPullRequestState;
  readonly checks: OrchestrationTaskChecksState;
  readonly review: OrchestrationTaskReviewState;
}

export type TaskWorkspaceEvent =
  | {
      readonly type: "review-comment-added";
      readonly key: string;
      readonly payload: ReviewCommentPayload;
    }
  | {
      readonly type: Exclude<TaskWorkspaceEventType, "review-comment-added">;
      readonly key: string;
      readonly payload: PullRequestEventPayload;
    };

export interface TaskPullRequestObservation {
  /** Provider-native repository identity, e.g. `owner/repo`. Part of every event key. */
  readonly repository: string;
  readonly summary: PullRequestSummary;
  /** Null when this tick skipped the detail read; checks then come from the summary. */
  readonly detail: PullRequestDetail | null;
  /** Null when this tick skipped the conversation read; no comment events are produced. */
  readonly activity: PullRequestActivity | null;
  readonly observedAt: string;
}

export interface TaskPullRequestNormalization {
  readonly pullRequest: OrchestrationTaskPullRequest;
  /** The snapshot differs from the previous one in something other than `observedAt`. */
  readonly changed: boolean;
  /**
   * This observation links a pull request the task did not have before. Comment
   * events from it are a baseline: they existed before the task knew the PR.
   */
  readonly firstLink: boolean;
  readonly events: ReadonlyArray<TaskWorkspaceEvent>;
}

export const taskPullRequestState = (
  summary: Pick<PullRequestSummary, "state" | "isDraft">,
): OrchestrationTaskPullRequestState =>
  summary.state === "open" && summary.isDraft === true ? "draft" : summary.state;

const FAILING_CHECK_STATUSES = new Set(["failure", "cancelled", "action-required"]);

/**
 * The host's own rollup wins, since every tick reads it. A detail's check list
 * stands in where the host reports no rollup, and the previous value where this
 * tick read neither.
 */
export const taskChecksState = (
  rollup: PullRequestChecksState | null | undefined,
  checks: ReadonlyArray<PullRequestCheck> | null,
  previous: OrchestrationTaskChecksState | null,
): OrchestrationTaskChecksState => {
  if (rollup != null) return rollup;
  if (checks === null) return previous ?? "none";
  if (checks.length === 0) return "none";
  if (checks.some((check) => FAILING_CHECK_STATUSES.has(check.status))) return "failing";
  if (checks.some((check) => check.status === "pending")) return "pending";
  return "passing";
};

const normalizeReviewState = (state: string | null): string | null =>
  state === null
    ? null
    : state
        .trim()
        .toLowerCase()
        .replace(/[_\s]+/g, "-");

/**
 * The host's review decision where it summarises one (GitHub). Elsewhere, the
 * latest verdict of each reviewer in the conversation: any outstanding request
 * for changes outweighs approvals.
 */
export const taskReviewState = (
  decision: PullRequestReviewDecision | null | undefined,
  comments: ReadonlyArray<PullRequestComment> | null,
  previous: OrchestrationTaskReviewState | null,
): OrchestrationTaskReviewState => {
  if (decision === "approved" || decision === "changes-requested") return decision;
  if (decision === "review-required") return "pending";
  if (comments === null) return previous ?? "none";
  const latestByReviewer = new Map<string, string>();
  const reviews = comments
    .filter((comment) => comment.kind === "review" && comment.author !== null)
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
  for (const review of reviews) {
    const state = normalizeReviewState(review.reviewState);
    if (state === "approved" || state === "changes-requested" || state === "dismissed") {
      latestByReviewer.set(review.author!.login.toLowerCase(), state);
    }
  }
  const verdicts = new Set(latestByReviewer.values());
  if (verdicts.has("changes-requested")) return "changes-requested";
  if (verdicts.has("approved")) return "approved";
  return "none";
};

export const pullRequestEventKeyBase = (input: {
  readonly provider: string;
  readonly repository: string;
  readonly number: number;
}) => `${input.provider}:${input.repository.toLowerCase()}:${input.number}`;

interface CommentCandidate {
  readonly comment: Pick<PullRequestComment, "id" | "author" | "body" | "createdAt" | "url">;
  readonly kind: PullRequestComment["kind"];
  readonly reviewState: string | null;
  readonly path: string | null;
  readonly thread: PullRequestReviewThread | null;
  /** The host resolved the conversation outside a line thread (Azure DevOps). */
  readonly resolved: boolean;
}

/**
 * Every remark in the conversation once: the flat list plus line comments that
 * only appear inside review threads (GitHub reads those from the threads).
 */
const commentCandidates = (activity: PullRequestActivity): ReadonlyArray<CommentCandidate> => {
  const threadOf = new Map<string, PullRequestReviewThread>();
  for (const thread of activity.reviewThreads) {
    for (const comment of thread.comments) threadOf.set(comment.id, thread);
  }
  const seen = new Set<string>();
  const candidates: Array<CommentCandidate> = [];
  for (const comment of activity.comments) {
    seen.add(comment.id);
    const thread = threadOf.get(comment.id) ?? null;
    candidates.push({
      comment,
      kind: comment.kind,
      reviewState: comment.reviewState,
      path: comment.path ?? thread?.path ?? null,
      thread,
      resolved: comment.isResolved === true,
    });
  }
  for (const thread of activity.reviewThreads) {
    for (const comment of thread.comments) {
      if (seen.has(comment.id)) continue;
      seen.add(comment.id);
      candidates.push({
        comment,
        kind: "review-comment",
        reviewState: null,
        path: thread.path,
        thread,
        resolved: false,
      });
    }
  }
  return candidates;
};

/**
 * Whether a remark asks something of the author. Skips empty bodies, bots, the
 * signed-in account itself (the agent's own replies post as that account), bare
 * approvals and, unless `includeResolved`, comments in resolved conversations. A
 * host that reports no resolution leaves it unknown, which counts as open.
 */
const isActionable = (
  candidate: CommentCandidate,
  viewer: string | null,
  includeResolved: boolean,
): boolean => {
  const { comment } = candidate;
  if (comment.body.trim().length === 0) return false;
  if (comment.author?.isBot === true) return false;
  if (viewer !== null && comment.author?.login.toLowerCase() === viewer.toLowerCase()) {
    return false;
  }
  if (candidate.kind === "review") {
    const state = normalizeReviewState(candidate.reviewState);
    if (state === "approved" || state === "dismissed") return false;
  }
  return includeResolved || (!candidate.resolved && candidate.thread?.isResolved !== true);
};

const toCommentPayload = (candidate: CommentCandidate): ReviewCommentPayload => ({
  commentId: candidate.comment.id,
  reviewThreadId: candidate.thread?.id ?? null,
  author: candidate.comment.author?.name?.trim() || candidate.comment.author?.login || null,
  body: candidate.comment.body,
  path: candidate.path,
  line: candidate.thread?.line ?? null,
  url: candidate.comment.url,
  createdAt: candidate.comment.createdAt,
});

const snapshotsEqual = (
  left: OrchestrationTaskPullRequest,
  right: OrchestrationTaskPullRequest,
): boolean =>
  left.provider === right.provider &&
  left.number === right.number &&
  left.url === right.url &&
  left.title === right.title &&
  left.state === right.state &&
  left.headBranch === right.headBranch &&
  left.baseBranch === right.baseBranch &&
  left.checks === right.checks &&
  left.review === right.review &&
  left.linkedAt === right.linkedAt;

const CHECK_EVENT_TYPES = {
  pending: "checks-started",
  failing: "checks-failed",
  passing: "checks-passed",
} as const;

const REVIEW_EVENT_TYPES = {
  approved: "review-approved",
  "changes-requested": "review-changes-requested",
} as const;

/**
 * Derive the task's next pull request snapshot and the workspace events between
 * `previous` and a fresh observation. Pure: the same inputs give the same
 * snapshot and the same event keys.
 */
export const normalizeTaskPullRequest = (
  previous: OrchestrationTaskPullRequest | null,
  observation: TaskPullRequestObservation,
): TaskPullRequestNormalization => {
  const { summary, detail, activity, observedAt } = observation;
  const firstLink =
    previous === null ||
    previous.number !== summary.number ||
    previous.provider !== summary.provider;
  const before = firstLink ? null : previous;
  const pullRequest: OrchestrationTaskPullRequest = {
    provider: summary.provider,
    number: summary.number,
    url: summary.url,
    title: summary.title,
    state: taskPullRequestState(summary),
    headBranch: summary.headBranch,
    baseBranch: summary.baseBranch,
    checks: taskChecksState(summary.checksState, detail?.checks ?? null, before?.checks ?? null),
    review: taskReviewState(
      summary.reviewDecision,
      activity?.comments ?? null,
      before?.review ?? null,
    ),
    linkedAt: before?.linkedAt ?? observedAt,
    observedAt,
  };
  const changed = previous === null || !snapshotsEqual(previous, pullRequest);

  const base = pullRequestEventKeyBase({
    provider: summary.provider,
    repository: observation.repository,
    number: summary.number,
  });
  const prPayload: PullRequestEventPayload = {
    number: pullRequest.number,
    url: pullRequest.url,
    state: pullRequest.state,
    checks: pullRequest.checks,
    review: pullRequest.review,
  };
  const events: Array<TaskWorkspaceEvent> = [];

  if (firstLink) {
    events.push({ type: "pull-request-discovered", key: `${base}:discovered`, payload: prPayload });
  } else if (
    before!.state !== pullRequest.state ||
    before!.title !== pullRequest.title ||
    before!.baseBranch !== pullRequest.baseBranch
  ) {
    events.push({
      type: "pull-request-updated",
      key: `${base}:updated:${pullRequest.state}:${summary.updatedAt}`,
      payload: prPayload,
    });
  }
  if (pullRequest.state === "merged") {
    events.push({ type: "pull-request-merged", key: `${base}:merged`, payload: prPayload });
  }

  if (pullRequest.review !== before?.review && pullRequest.review in REVIEW_EVENT_TYPES) {
    const review = pullRequest.review as keyof typeof REVIEW_EVENT_TYPES;
    events.push({
      type: REVIEW_EVENT_TYPES[review],
      key: `${base}:review:${review}:${summary.updatedAt}`,
      payload: prPayload,
    });
  }

  if (pullRequest.checks !== before?.checks && pullRequest.checks !== "none") {
    const headSha = activity?.commits.at(-1)?.oid ?? summary.updatedAt;
    events.push({
      type: CHECK_EVENT_TYPES[pullRequest.checks],
      key: `${base}:checks:${headSha}:${pullRequest.checks}`,
      payload: prPayload,
    });
  }

  // Comments on a closed or merged pull request have nothing left to change.
  if (activity !== null && (pullRequest.state === "open" || pullRequest.state === "draft")) {
    const viewer = detail?.viewer ?? null;
    for (const candidate of commentCandidates(activity)) {
      if (!isActionable(candidate, viewer, firstLink)) continue;
      events.push({
        type: "review-comment-added",
        key: `${base}:comment:${candidate.comment.id}`,
        payload: toCommentPayload(candidate),
      });
    }
  }

  return { pullRequest, changed, firstLink, events };
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `PR feedback – Oct 1 16:42`. `month` is 1-based, as `DateTime.toParts` reports it. */
export const reviewFeedbackThreadTitle = (at: {
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}): string =>
  `PR feedback – ${MONTHS[at.month - 1]} ${at.day} ${String(at.hour).padStart(2, "0")}:${String(at.minute).padStart(2, "0")}`;

/** The structured first message of an automated review-feedback thread. */
export const reviewFeedbackPrompt = (input: {
  readonly taskTitle: string;
  readonly pullRequest: Pick<OrchestrationTaskPullRequest, "number" | "url">;
  readonly branch: string;
  readonly comments: ReadonlyArray<ReviewCommentPayload>;
}): string => {
  const feedback = input.comments.map((comment, index) =>
    [
      `### Comment ${index + 1}`,
      `File: ${comment.path ?? "(general comment)"}`,
      ...(comment.line === null ? [] : [`Line: ${comment.line}`]),
      `Reviewer: ${comment.author ?? "unknown"}`,
      ...(comment.url === null ? [] : [`Link: ${comment.url}`]),
      "Comment:",
      comment.body
        .trim()
        .split(/\r?\n/)
        .map((line) => `> ${line}`)
        .join("\n"),
    ].join("\n"),
  );
  return [
    "Address the newly received pull-request review feedback.",
    "",
    `Task: ${input.taskTitle}`,
    `Pull request: #${input.pullRequest.number} (${input.pullRequest.url})`,
    `Branch: ${input.branch}`,
    "",
    "## New feedback",
    "",
    feedback.join("\n\n"),
    "",
    "## Instructions",
    "",
    "1. Inspect the current code and the surrounding implementation.",
    "2. Determine whether each piece of feedback is valid.",
    "3. If valid, implement the requested correction.",
    "4. Add or update relevant tests.",
    "5. Run the appropriate verification commands.",
    "6. Commit and push the fix to the existing task branch. Do not create another branch.",
    "7. Do not modify unrelated code.",
    "8. If the feedback is ambiguous, unsafe, contradictory, or requires a product decision, stop and ask the user before changing anything.",
  ].join("\n");
};
