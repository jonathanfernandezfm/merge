import { decodeExpiredPolicyEvaluationIds } from "@t3tools/contracts";
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
import {
  decodePolicyEvaluationsJson,
  decodeReviewDecisionJson,
  decodeReviewThreadsJson,
} from "./azureDevOpsReviewJson.ts";

/** Same bound upstream gives its own thread read. */
const THREADS_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** Matches upstream's `REST_API_VERSION` for `az devops invoke`. */
const REST_API_VERSION = "7.1";

/**
 * Fills what upstream leaves empty for Azure DevOps (policy checks, vote decision, review threads)
 * and re-queues expired builds after auto-complete. Called once at the `scm-ado` seam; swaps those
 * methods on the built provider. Without the az services in context it does nothing.
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
  const runAction = provider.runAction;

  const executeJson = (cwd: string, args: ReadonlyArray<string>, maxOutputBytes?: number) =>
    azure
      .execute({
        cwd,
        args: [...args, "--only-show-errors", "--output", "json"],
        ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
      })
      .pipe(Effect.map((result) => result.stdout.trim()));

  // A failed read leaves its part unknown rather than losing the detail.
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
  const readPullRequest = (cwd: string, number: number) =>
    executeJson(cwd, ["repos", "pr", "show", "--detect", "true", "--id", String(number)]).pipe(
      Effect.option,
    );

  const requeueExpiredChecks = (cwd: string, number: number) =>
    requeueExpiredAzureDevOpsChecks(azure, cwd, number);

  Object.assign(provider, {
    getChangeRequest: (input) =>
      Effect.all(
        [
          getChangeRequest(input),
          readPolicies(input.cwd, input.number),
          readPullRequest(input.cwd, input.number),
        ],
        { concurrency: 3 },
      ).pipe(
        Effect.map(([detail, policies, shown]) => {
          // Upstream's own values win once it reads them itself.
          const checks =
            detail.checks.length === 0 && Option.isSome(policies)
              ? decodePolicyEvaluationsJson(policies.value, detail.url)
              : Result.succeed(detail.checks);
          const reviewDecision =
            detail.reviewDecision == null && Option.isSome(shown)
              ? decodeReviewDecisionJson(shown.value)
              : Result.succeed(detail.reviewDecision);
          return {
            ...detail,
            checks: Result.isSuccess(checks) ? checks.success : detail.checks,
            ...(Result.isSuccess(reviewDecision) && reviewDecision.success != null
              ? { reviewDecision: reviewDecision.success }
              : {}),
          };
        }),
      ),

    // Azure never re-runs an expired build by itself, so auto-complete would wait on it forever.
    // Queuing them is best effort: auto-complete is already set either way.
    runAction: (input) =>
      runAction(input).pipe(
        Effect.andThen(
          input.action === "enable-auto-merge"
            ? requeueExpiredChecks(input.cwd, input.number).pipe(Effect.ignore)
            : Effect.void,
        ),
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

/**
 * Queues each expired policy evaluation of pull request `number` again and returns how many. The
 * list is read fresh so no evaluation id has to travel to the client and back.
 */
const requeueExpiredAzureDevOpsChecks = Effect.fn("MergeAzureDevOps.requeueExpiredChecks")(
  function* (azure: AzureDevOpsCli.AzureDevOpsCli["Service"], cwd: string, number: number) {
    const run = (args: ReadonlyArray<string>) =>
      azure.execute({ cwd, args: [...args, "--only-show-errors", "--output", "json"] });
    const id = String(number);
    const listed = yield* run(["repos", "pr", "policy", "list", "--detect", "true", "--id", id]);
    const expired = decodeExpiredPolicyEvaluationIds(listed.stdout);
    if (expired === null) {
      return yield* new AzureDevOpsPullRequestCli.AzureDevOpsPullRequestReadError({
        command: "az",
        cwd,
        operation: "requeueExpiredChecks",
        cause: "Unreadable policy list.",
      });
    }
    yield* Effect.forEach(
      expired,
      (evaluationId) =>
        run([
          "repos",
          "pr",
          "policy",
          "queue",
          "--detect",
          "true",
          "--id",
          id,
          "--evaluation-id",
          evaluationId,
        ]),
      { discard: true },
    );
    return expired.length;
  },
);
