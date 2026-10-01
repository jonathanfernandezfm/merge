import {
  ProjectId,
  type OrchestrationTaskPullRequest,
  type PullRequestActivity,
  type PullRequestComment,
  type PullRequestDetail,
  type PullRequestSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  normalizeTaskPullRequest,
  reviewFeedbackPrompt,
  reviewFeedbackThreadTitle,
  taskChecksState,
  taskReviewState,
  type TaskPullRequestObservation,
} from "./taskWorkspaceEvents.ts";

const OBSERVED_AT = "2026-10-01T12:00:00.000Z";

const summary = (overrides: Partial<PullRequestSummary> = {}): PullRequestSummary => ({
  provider: "github",
  projectId: ProjectId.make("project"),
  repository: "Owner/Repo",
  number: 7,
  title: "Widgets",
  url: "https://github.com/owner/repo/pull/7",
  state: "open",
  headBranch: "feature/widgets",
  baseBranch: "main",
  updatedAt: "2026-10-01T11:00:00.000Z",
  ...overrides,
});

const comment = (id: string, overrides: Partial<PullRequestComment> = {}): PullRequestComment => ({
  id,
  kind: "issue-comment",
  author: { login: "sarah", name: "Sarah", avatarUrl: null },
  body: `body ${id}`,
  createdAt: "2026-10-01T10:00:00.000Z",
  url: null,
  path: null,
  reviewState: null,
  ...overrides,
});

const activity = (overrides: Partial<PullRequestActivity> = {}): PullRequestActivity => ({
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  reviewThreads: [],
  commits: [],
  ...overrides,
});

const detail = (overrides: Partial<PullRequestDetail> = {}) =>
  ({ checks: [], viewer: "me", ...overrides }) as unknown as PullRequestDetail;

const observe = (
  overrides: Partial<TaskPullRequestObservation> = {},
): TaskPullRequestObservation => ({
  repository: "Owner/Repo",
  summary: summary(),
  detail: detail(),
  activity: activity(),
  observedAt: OBSERVED_AT,
  ...overrides,
});

/** The snapshot a first observation links, as the task would now hold it. */
const linked = (
  overrides: Partial<OrchestrationTaskPullRequest> = {},
): OrchestrationTaskPullRequest => ({
  ...normalizeTaskPullRequest(null, observe()).pullRequest,
  ...overrides,
});

describe("taskChecksState", () => {
  it("prefers the host rollup, then the check list, then the previous value", () => {
    expect(taskChecksState("passing", [], "failing")).toBe("passing");
    expect(
      taskChecksState(
        undefined,
        [
          { name: "a", status: "success", description: null, url: null },
          { name: "b", status: "cancelled", description: null, url: null },
        ],
        null,
      ),
    ).toBe("failing");
    expect(
      taskChecksState(
        null,
        [
          { name: "a", status: "success", description: null, url: null },
          { name: "b", status: "pending", description: null, url: null },
        ],
        null,
      ),
    ).toBe("pending");
    expect(
      taskChecksState(null, [{ name: "a", status: "skipped", description: null, url: null }], null),
    ).toBe("passing");
    expect(taskChecksState(null, [], "passing")).toBe("none");
    expect(taskChecksState(null, null, "pending")).toBe("pending");
  });
});

describe("taskReviewState", () => {
  it("maps the host decision", () => {
    expect(taskReviewState("approved", null, null)).toBe("approved");
    expect(taskReviewState("changes-requested", null, null)).toBe("changes-requested");
    expect(taskReviewState("review-required", null, "approved")).toBe("pending");
  });

  it("falls back to each reviewer's latest verdict", () => {
    const reviews = [
      comment("1", { kind: "review", reviewState: "CHANGES_REQUESTED" }),
      comment("2", {
        kind: "review",
        reviewState: "APPROVED",
        createdAt: "2026-10-01T11:00:00.000Z",
      }),
    ];
    expect(taskReviewState(null, reviews, null)).toBe("approved");
    const other = comment("3", {
      kind: "review",
      reviewState: "changes_requested",
      author: { login: "bob", name: null, avatarUrl: null },
    });
    expect(taskReviewState(undefined, [...reviews, other], null)).toBe("changes-requested");
    expect(taskReviewState(undefined, null, "approved")).toBe("approved");
    expect(taskReviewState(undefined, [], "approved")).toBe("none");
  });
});

describe("normalizeTaskPullRequest", () => {
  it("links a new pull request and baselines its comments with deterministic keys", () => {
    const result = normalizeTaskPullRequest(
      null,
      observe({
        summary: summary({ isDraft: true, checksState: "pending" }),
        activity: activity({ comments: [comment("c1")] }),
      }),
    );
    expect(result.firstLink).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.pullRequest).toMatchObject({
      number: 7,
      state: "draft",
      checks: "pending",
      review: "none",
      linkedAt: OBSERVED_AT,
    });
    expect(result.events.map((event) => event.key)).toEqual([
      "github:owner/repo:7:discovered",
      "github:owner/repo:7:checks:2026-10-01T11:00:00.000Z:pending",
      "github:owner/repo:7:comment:c1",
    ]);
    expect(normalizeTaskPullRequest(null, observe()).events.map((event) => event.key)).toEqual(
      normalizeTaskPullRequest(null, observe()).events.map((event) => event.key),
    );
  });

  it("reports nothing new when the host state has not changed", () => {
    const previous = linked();
    const result = normalizeTaskPullRequest(
      previous,
      observe({ activity: null, observedAt: "2026-10-01T12:01:00.000Z" }),
    );
    expect(result.changed).toBe(false);
    expect(result.firstLink).toBe(false);
    expect(result.events).toEqual([]);
    expect(result.pullRequest.linkedAt).toBe(previous.linkedAt);
  });

  it("filters comments down to actionable feedback", () => {
    const previous = linked();
    const result = normalizeTaskPullRequest(
      previous,
      observe({
        activity: activity({
          comments: [
            comment("mine", { author: { login: "ME", name: null, avatarUrl: null } }),
            comment("bot", { author: { login: "ci", name: null, avatarUrl: null, isBot: true } }),
            comment("empty", { body: "  " }),
            comment("lgtm", { kind: "review", reviewState: "APPROVED" }),
            comment("summary", { kind: "review", reviewState: "COMMENTED" }),
            // A general conversation the host resolved (Azure DevOps) is not a line thread.
            comment("closed-general", { isResolved: true }),
          ],
          reviewThreads: [
            {
              id: "t-open",
              path: "src/a.ts",
              line: 12,
              side: "right",
              isResolved: false,
              isOutdated: false,
              comments: [
                {
                  id: "line",
                  author: { login: "sarah", name: "Sarah", avatarUrl: null },
                  body: "Handle inherited permissions",
                  createdAt: OBSERVED_AT,
                  url: "https://example.test/line",
                },
              ],
            },
            {
              id: "t-done",
              path: "src/b.ts",
              line: 3,
              side: "right",
              isResolved: true,
              isOutdated: false,
              comments: [
                {
                  id: "resolved",
                  author: { login: "sarah", name: null, avatarUrl: null },
                  body: "done",
                  createdAt: OBSERVED_AT,
                  url: null,
                },
              ],
            },
          ],
        }),
      }),
    );
    const comments = result.events.filter((event) => event.type === "review-comment-added");
    expect(comments.map((event) => event.key)).toEqual([
      "github:owner/repo:7:comment:summary",
      "github:owner/repo:7:comment:line",
    ]);
    expect(comments[1]?.payload).toEqual({
      commentId: "line",
      reviewThreadId: "t-open",
      author: "Sarah",
      body: "Handle inherited permissions",
      path: "src/a.ts",
      line: 12,
      url: "https://example.test/line",
      createdAt: OBSERVED_AT,
    });
  });

  it("emits merge, review and checks transitions", () => {
    const previous = linked({ checks: "pending", review: "pending" });
    const result = normalizeTaskPullRequest(
      previous,
      observe({
        summary: summary({
          state: "merged",
          reviewDecision: "approved",
          checksState: "failing",
          mergedAt: OBSERVED_AT,
        }),
        activity: activity({
          commits: [
            { oid: "aaa", messageHeadline: "a", committedDate: OBSERVED_AT },
            { oid: "bbb", messageHeadline: "b", committedDate: OBSERVED_AT },
          ],
          comments: [comment("late")],
        }),
      }),
    );
    expect(result.pullRequest.state).toBe("merged");
    expect(result.events.map((event) => [event.type, event.key])).toEqual([
      ["pull-request-updated", "github:owner/repo:7:updated:merged:2026-10-01T11:00:00.000Z"],
      ["pull-request-merged", "github:owner/repo:7:merged"],
      ["review-approved", "github:owner/repo:7:review:approved:2026-10-01T11:00:00.000Z"],
      ["checks-failed", "github:owner/repo:7:checks:bbb:failing"],
    ]);
  });

  it("treats a different pull request number as a new link", () => {
    const result = normalizeTaskPullRequest(linked({ number: 3 }), observe());
    expect(result.firstLink).toBe(true);
    expect(result.pullRequest.number).toBe(7);
  });
});

describe("review feedback thread", () => {
  it("formats the title and a prompt carrying every comment", () => {
    expect(reviewFeedbackThreadTitle({ month: 10, day: 1, hour: 9, minute: 5 })).toBe(
      "PR feedback – Oct 1 09:05",
    );
    const prompt = reviewFeedbackPrompt({
      taskTitle: "ABC-123 – Permissions",
      pullRequest: { number: 827, url: "https://example.test/pr/827" },
      branch: "feature/abc-123",
      comments: [
        {
          commentId: "1",
          reviewThreadId: null,
          author: "Sarah",
          body: "Handle inherited permissions",
          path: "src/PermissionService.ts",
          line: 184,
          url: null,
          createdAt: OBSERVED_AT,
        },
      ],
    });
    expect(prompt).toContain("Task: ABC-123 – Permissions");
    expect(prompt).toContain("Pull request: #827 (https://example.test/pr/827)");
    expect(prompt).toContain("Branch: feature/abc-123");
    expect(prompt).toContain("File: src/PermissionService.ts\nLine: 184\nReviewer: Sarah");
    expect(prompt).toContain("> Handle inherited permissions");
    expect(prompt).toContain("requires a product decision, stop and ask the user");
  });
});
