import { describe, expect, it } from "vite-plus/test";

import { decodeExpiredPolicyEvaluationIds } from "./pullRequests.ts";

describe("decodeExpiredPolicyEvaluationIds", () => {
  it("names only the expired evaluations, from either answer shape", () => {
    const evaluations = [
      { evaluationId: "eval-expired", status: "queued", context: { isExpired: true } },
      { evaluationId: "eval-live", status: "queued", context: { isExpired: false } },
      { status: "queued", context: { isExpired: true } },
      "not an evaluation",
    ];
    expect(decodeExpiredPolicyEvaluationIds(JSON.stringify(evaluations))).toEqual(["eval-expired"]);
    expect(decodeExpiredPolicyEvaluationIds(JSON.stringify({ value: evaluations }))).toEqual([
      "eval-expired",
    ]);
  });

  it("reads no output as no policies, and junk as unreadable", () => {
    expect(decodeExpiredPolicyEvaluationIds("")).toEqual([]);
    expect(decodeExpiredPolicyEvaluationIds("not json")).toBeNull();
  });
});
