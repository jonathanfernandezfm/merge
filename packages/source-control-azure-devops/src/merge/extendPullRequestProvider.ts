import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type {
  ProviderChangeRequestActivity,
  PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";

import * as AzureDevOpsCli from "../server/AzureDevOpsCli.ts";
import * as AzureDevOpsPullRequestCli from "../server/AzureDevOpsPullRequestCli.ts";
import { decodeThreadsJson } from "../server/azureDevOpsPullRequestJson.ts";
import { decodePolicyEvaluationsJson, decodeReviewThreadsJson } from "./azureDevOpsReviewJson.ts";

/** Same bound upstream gives its own thread read. */
const THREADS_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** Matches upstream's `REST_API_VERSION` for `az devops invoke`. */
const REST_API_VERSION = "7.1";

/**
 * Fills in what upstream leaves empty for Azure DevOps: branch policies as checks on the detail,
 * and file threads as review threads on the activity. Called once at the `scm-ado` seam, after
 * upstream built `provider`; it swaps those two methods in place so the seam stays one line.
 * Without the az services in context (upstream's own tests) it leaves the provider alone.
 */
export const extendAzureDevOpsPullRequestProvider = Effect.fn(
  "MergeAzureDevOps.extendPullRequestProvider",
)(function* (provider: PullRequestProviderApi) {
  const azureOption = yield* Effect.serviceOption(AzureDevOpsCli.AzureDevOpsCli);
  const cliOption = yield* Effect.serviceOption(
    AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli,
  );
  if (Option.isNone(azureOption) || Option.isNone(cliOption)) return;
  const azure = azureOption.value;
  const cli = cliOption.value;
  const getChangeRequest = provider.getChangeRequest;
  const getChangeRequestActivity = provider.getChangeRequestActivity;

  const executeJson = (cwd: string, args: ReadonlyArray<string>, maxOutputBytes?: number) =>
    azure
      .execute({
        cwd,
        args: [...args, "--only-show-errors", "--output", "json"],
        ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
      })
      .pipe(Effect.map((result) => result.stdout.trim()));

  // A failed policy read leaves the checks unknown rather than losing the detail.
  const readPolicies = (cwd: string, number: number) =>
    executeJson(cwd, [
      "repos",
      "pr",
      "policy",
      "list",
      "--detect",
      "true",
      "--id",
      String(number),
    ]).pipe(Effect.option);

  Object.assign(provider, {
    getChangeRequest: (input) =>
      Effect.all([getChangeRequest(input), readPolicies(input.cwd, input.number)], {
        concurrency: 2,
      }).pipe(
        Effect.map(([detail, raw]) => {
          if (Option.isNone(raw)) return detail;
          const checks = decodePolicyEvaluationsJson(raw.value, detail.url);
          return Result.isSuccess(checks) ? { ...detail, checks: checks.success } : detail;
        }),
      ),

    // One threads read gives both the timeline and the review threads. Anything that goes wrong
    // falls back to upstream's own read, which maps the error or marks the comments truncated.
    getChangeRequestActivity: Effect.fn("MergeAzureDevOps.getChangeRequestActivity")(
      function* (input: Parameters<typeof getChangeRequestActivity>[0]) {
        const pullRequest = yield* cli.getPullRequest({ cwd: input.cwd, number: input.number });
        const location = pullRequest.location;
        if (location === null) return yield* Effect.fail("no-location" as const);
        const raw = yield* executeJson(
          input.cwd,
          [
            "devops",
            "invoke",
            "--detect",
            "true",
            "--area",
            "git",
            "--resource",
            "pullRequestThreads",
            "--api-version",
            REST_API_VERSION,
            "--route-parameters",
            `project=${location.project}`,
            `repositoryId=${location.repository}`,
            `pullRequestId=${input.number}`,
          ],
          THREADS_MAX_OUTPUT_BYTES,
        );
        const comments = decodeThreadsJson(raw);
        if (!Result.isSuccess(comments)) return yield* Effect.fail("unreadable" as const);
        const threads = decodeReviewThreadsJson(raw, comments.success);
        return {
          comments: comments.success,
          commentCount: comments.success.length,
          commentsTruncated: false,
          reviewThreads: Result.isSuccess(threads) ? threads.success : [],
          commits: [],
        } satisfies ProviderChangeRequestActivity;
      },
      (effect, input) => effect.pipe(Effect.catch(() => getChangeRequestActivity(input))),
    ),
  } satisfies Partial<PullRequestProviderApi>);
});
