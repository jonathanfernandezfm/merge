// @effect-diagnostics nodeBuiltinImport:off -- Reads recorded az fixtures synchronously.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AzureDevOpsCli from "../server/AzureDevOpsCli.ts";
import * as AzureDevOpsPullRequestCli from "../server/AzureDevOpsPullRequestCli.ts";
import { make } from "../server/AzureDevOpsPullRequestProvider.ts";

const fixture = (name: string) =>
  NodeFS.readFileSync(new URL(`./testFixtures/${name}`, import.meta.url), "utf8");

const PULL_REQUEST = {
  number: 42,
  title: "Permissions",
  url: "https://dev.azure.com/acme/platform/_git/web/pullrequest/42",
  author: null,
  headBranch: "feature/permissions",
  baseBranch: "main",
  state: "open" as const,
  isDraft: false,
  mergeability: "mergeable" as const,
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-02T00:00:00Z",
  closedAt: null,
  body: "",
  reviewRequestLogins: [],
  reviewers: [],
  location: { project: "platform", repository: "web" },
  autoMergeEnabled: false,
};

const REF = { cwd: "/w", repository: "acme/web", host: "dev.azure.com", number: 42 };

/** Recorded az answers by subcommand; `fail` makes every az call fail. */
function provide(options: { readonly fail?: boolean } = {}) {
  const calls: Array<ReadonlyArray<string>> = [];
  const output = (stdout: string) => ({
    exitCode: 0 as never,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  });
  const azure = Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({
    execute: (input) => {
      calls.push(input.args);
      if (options.fail) {
        return Effect.fail(
          new AzureDevOpsCli.AzureDevOpsCommandFailedError({
            operation: "execute",
            command: "az",
            cwd: input.cwd,
            argumentCount: input.args.length,
            cause: "boom",
          }),
        );
      }
      return Effect.succeed(
        output(
          input.args.includes("policy")
            ? fixture("azureDevOpsPolicyList.json")
            : fixture("azureDevOpsThreads.json"),
        ),
      );
    },
  });
  const cli = Layer.mock(AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli)({
    getPullRequest: () => Effect.succeed(PULL_REQUEST),
    listIterations: () => Effect.succeed([]),
    listThreads: () => Effect.succeed([]),
  });
  return { calls, layer: Layer.merge(azure, cli) };
}

describe("Azure DevOps pull request extensions", () => {
  it.effect("reads branch policies as the detail's checks", () =>
    Effect.gen(function* () {
      const { calls, layer } = provide();
      const provider = yield* make.pipe(Effect.provide(layer));
      const detail = yield* provider.getChangeRequest(REF);

      expect(detail.checks.map((check) => [check.name, check.status])).toEqual([
        ["CI", "failure"],
        ["Nightly e2e", "neutral"],
        ["sonarcloud/quality-gate", "pending"],
        ["Docs build", "skipped"],
      ]);
      expect(calls).toEqual([
        [
          "repos",
          "pr",
          "policy",
          "list",
          "--detect",
          "true",
          "--id",
          "42",
          "--only-show-errors",
          "--output",
          "json",
        ],
      ]);
    }),
  );

  it.effect("keeps the detail without checks when the policy read fails", () =>
    Effect.gen(function* () {
      const provider = yield* make.pipe(Effect.provide(provide({ fail: true }).layer));
      const detail = yield* provider.getChangeRequest(REF);
      expect(detail.number).toBe(42);
      expect(detail.checks).toEqual([]);
    }),
  );

  it.effect("reads the timeline and the review threads from one threads read", () =>
    Effect.gen(function* () {
      const { calls, layer } = provide();
      const provider = yield* make.pipe(Effect.provide(layer));
      const activity = yield* provider.getChangeRequestActivity(REF);

      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual(
        expect.arrayContaining([
          "pullRequestThreads",
          "project=platform",
          "repositoryId=web",
          "pullRequestId=42",
        ]),
      );
      expect(activity.commentsTruncated).toBe(false);
      expect(activity.comments.map((comment) => comment.id)).toEqual([
        "102:1",
        "103:1",
        "102:2",
        "103:2",
        "104:1",
        "106:1",
      ]);
      expect(activity.reviewThreads.map((thread) => [thread.id, thread.isResolved])).toEqual([
        ["102", false],
        ["103", true],
        ["106", false],
      ]);
    }),
  );

  it.effect("falls back to upstream's read when the threads read fails", () =>
    Effect.gen(function* () {
      const provider = yield* make.pipe(Effect.provide(provide({ fail: true }).layer));
      const activity = yield* provider.getChangeRequestActivity(REF);
      expect(activity.reviewThreads).toEqual([]);
      expect(activity.comments).toEqual([]);
    }),
  );
});
