// @effect-diagnostics nodeBuiltinImport:off -- Reads recorded az fixtures synchronously.
import * as NodeFS from "node:fs";

import { decodeExpiredPolicyEvaluationIds } from "@t3tools/contracts";
import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import { decodeThreadsJson } from "../server/azureDevOpsPullRequestJson.ts";
import {
  decodePolicyEvaluationsJson,
  decodeReviewDecisionJson,
  decodeReviewThreadsJson,
} from "./azureDevOpsReviewJson.ts";

/** Recorded `az` answers. */
const fixture = (name: string) =>
  NodeFS.readFileSync(new URL(`./testFixtures/${name}`, import.meta.url), "utf8");

const asJson = (value: unknown) => JSON.stringify(value);

function expectSuccess<A>(result: Result.Result<A, unknown>): A {
  if (!Result.isSuccess(result)) throw new Error("expected a successful decode");
  return result.success;
}

describe("decodePolicyEvaluationsJson", () => {
  const PULL_REQUEST_URL = "https://dev.azure.com/acme/platform/_git/web/pullrequest/42";

  it("reads build and status policies as checks, and nothing else", () => {
    const checks = expectSuccess(
      decodePolicyEvaluationsJson(fixture("azureDevOpsPolicyList.json"), PULL_REQUEST_URL),
    );

    expect(checks).toEqual([
      {
        name: "CI",
        status: "failure",
        description: null,
        url: "https://dev.azure.com/acme/platform/_build/results?buildId=9071",
        required: true,
      },
      // An optional build that failed does not hold the merge.
      {
        name: "Nightly e2e",
        status: "neutral",
        description: "Optional",
        url: "https://dev.azure.com/acme/platform/_build/results?buildId=9072",
        required: false,
      },
      {
        name: "sonarcloud/quality-gate",
        status: "pending",
        description: null,
        url: null,
        required: true,
      },
      { name: "Docs build", status: "skipped", description: null, url: null, required: true },
    ]);
  });

  it("reads an expired build as needing action rather than queued", () => {
    const raw = asJson([
      {
        status: "queued",
        configuration: { type: { displayName: "Build" }, settings: { displayName: "Compliance" } },
        context: { buildId: 530658, isExpired: true },
      },
      {
        status: "queued",
        configuration: { type: { displayName: "Build" }, settings: { displayName: "CI" } },
        context: { buildId: 530659, isExpired: false },
      },
    ]);

    expect(
      expectSuccess(decodePolicyEvaluationsJson(raw, PULL_REQUEST_URL)).map(
        (check) => check.status,
      ),
    ).toEqual(["action-required", "pending"]);
  });

  it("reads no policies at all as no checks", () => {
    expect(expectSuccess(decodePolicyEvaluationsJson("", PULL_REQUEST_URL))).toEqual([]);
    expect(expectSuccess(decodePolicyEvaluationsJson("[]", null))).toEqual([]);
  });

  it("skips a disabled policy and leaves out a link it cannot build", () => {
    const checks = expectSuccess(
      decodePolicyEvaluationsJson(
        asJson({
          value: [
            {
              status: "approved",
              configuration: { isEnabled: false, type: { displayName: "Build" } },
            },
            {
              status: "queued",
              configuration: { settings: { displayName: "CI" }, type: { displayName: "Build" } },
              context: { buildId: 1 },
            },
          ],
        }),
        null,
      ),
    );

    expect(checks).toEqual([
      { name: "CI", status: "pending", description: null, url: null, required: true },
    ]);
  });

  it("fails on output that is not JSON", () => {
    expect(Result.isSuccess(decodePolicyEvaluationsJson("not json", null))).toBe(false);
  });
});

describe("decodeReviewThreadsJson from recorded az output", () => {
  const raw = fixture("azureDevOpsThreads.json");
  const threads = () =>
    expectSuccess(decodeReviewThreadsJson(raw, expectSuccess(decodeThreadsJson(raw))));

  it("pins file threads to their line and side, without Azure's leading slash", () => {
    expect(
      threads().map((thread) => ({
        id: thread.id,
        path: thread.path,
        line: thread.line,
        side: thread.side,
        isResolved: thread.isResolved,
        comments: thread.comments.map((comment) => comment.id),
      })),
    ).toEqual([
      {
        id: "102",
        path: "src/PermissionService.ts",
        line: 184,
        side: "right",
        isResolved: false,
        comments: ["102:1", "102:2"],
      },
      {
        id: "103",
        path: "src/PermissionService.ts",
        line: 3,
        side: "right",
        isResolved: true,
        comments: ["103:1", "103:2"],
      },
      // A remark on a removed line sits on the left; a pending thread is still open.
      {
        id: "106",
        path: "src/legacy.ts",
        line: 31,
        side: "left",
        isResolved: false,
        comments: ["106:1"],
      },
    ]);
  });
});

describe("decodeExpiredPolicyEvaluationIds", () => {
  it("names only the expired evaluations, for requeue", () => {
    const raw = asJson([
      { evaluationId: "eval-expired", status: "queued", context: { isExpired: true } },
      { evaluationId: "eval-live", status: "queued", context: { isExpired: false } },
      { status: "queued", context: { isExpired: true } },
    ]);
    expect(decodeExpiredPolicyEvaluationIds(raw)).toEqual(["eval-expired"]);
    expect(decodeExpiredPolicyEvaluationIds("")).toEqual([]);
  });
});

describe("decodeReviewDecisionJson", () => {
  const withVotes = (reviewers: ReadonlyArray<Record<string, unknown>>) =>
    expectSuccess(decodeReviewDecisionJson(asJson({ reviewers })));

  it("holds the change while anyone waits for the author, from recorded az output", () => {
    expect(
      expectSuccess(decodeReviewDecisionJson(fixture("azureDevOpsPullRequestShow.json"))),
    ).toBe("changes-requested");
  });

  it("reads a rejection as changes requested", () => {
    expect(withVotes([{ vote: 10 }, { vote: -10 }])).toBe("changes-requested");
  });

  it("approves once a reviewer approves and nobody objects", () => {
    expect(withVotes([{ vote: 5 }, { vote: 0 }])).toBe("approved");
  });

  it("still owes a review while a required reviewer has not approved", () => {
    expect(withVotes([{ vote: 10 }, { vote: 0, isRequired: true }])).toBe("review-required");
    expect(withVotes([{ vote: 0 }])).toBe("review-required");
  });

  it("has no decision when nobody was asked", () => {
    expect(withVotes([])).toBeNull();
  });
});
