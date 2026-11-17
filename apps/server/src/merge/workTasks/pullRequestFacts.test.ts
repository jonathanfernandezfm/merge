import { assert, describe, it } from "@effect/vitest";
import type { PullRequestCheck, PullRequestDetail } from "@t3tools/contracts";

import { countUnresolvedThreads, pullRequestFacts, rollupChecks } from "./pullRequestFacts.ts";

const check = (over: Partial<PullRequestCheck>): PullRequestCheck => ({
  name: "c",
  status: "success",
  description: null,
  url: null,
  required: true,
  ...over,
});
const thread = (isResolved: boolean) => ({ id: "t", isResolved }) as never;

describe("rollupChecks", () => {
  it("required failing beats optional", () => {
    assert.equal(
      rollupChecks([check({ status: "failure" }), check({ status: "failure", required: false })]),
      "failing",
    );
  });
  it("only optional failing is none", () => {
    assert.equal(rollupChecks([check({ status: "failure", required: false })]), "none");
  });
  it("required pending is pending", () => {
    assert.equal(rollupChecks([check({ status: "pending" }), check({})]), "pending");
  });
  it("all required passed is passing", () => {
    assert.equal(rollupChecks([check({}), check({ status: "skipped" })]), "passing");
  });
  it("placeholder alone is none", () => {
    assert.equal(rollupChecks([check({ placeholder: true, status: "pending" })]), "none");
  });
});

describe("countUnresolvedThreads", () => {
  it("counts unresolved across review and overview threads", () => {
    assert.equal(
      countUnresolvedThreads({
        reviewThreads: [thread(false), thread(true)],
        overviewThreads: [thread(false)],
      }),
      2,
    );
  });
});

describe("pullRequestFacts", () => {
  const detail = (over: object) =>
    ({
      number: 7,
      mergeability: "conflicting",
      checks: [],
      ...over,
    }) as unknown as PullRequestDetail;
  it("maps review-required to pending", () => {
    const f = pullRequestFacts(
      detail({}),
      { reviewDecision: "review-required" },
      { reviewThreads: [], overviewThreads: [] },
      "2026-11-17T00:00:00.000Z",
    );
    assert.deepEqual(f, {
      number: 7,
      review: "pending",
      checks: "none",
      mergeConflicts: true,
      unresolvedComments: 0,
      syncedAt: "2026-11-17T00:00:00.000Z",
    });
  });
  it("missing decision is none", () => {
    assert.equal(
      pullRequestFacts(detail({}), {}, { reviewThreads: [] }, "2026-11-17T00:00:00.000Z").review,
      "none",
    );
    assert.equal(
      pullRequestFacts(
        detail({}),
        { reviewDecision: null },
        { reviewThreads: [] },
        "2026-11-17T00:00:00.000Z",
      ).review,
      "none",
    );
  });
  it("approved and changes-requested pass through", () => {
    for (const decision of ["approved", "changes-requested"] as const) {
      assert.equal(
        pullRequestFacts(
          detail({}),
          { reviewDecision: decision },
          { reviewThreads: [] },
          "2026-11-17T00:00:00.000Z",
        ).review,
        decision,
      );
    }
  });
});
