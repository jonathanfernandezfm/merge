import {
  SourceControlProviderKind,
  SourceControlRepositoryError,
  decodeExpiredPolicyEvaluationIds,
  type RequeueExpiredChecksInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { azJson, decoded, requireAzureDevOps } from "../workItems/workItems.ts";

/** Queues each expired build policy of an Azure DevOps pull request again. */
export const requeueExpiredChecks = Effect.fn("MergePullRequests.requeueExpiredChecks")(function* (
  input: RequeueExpiredChecksInput,
) {
  const op = "requeueExpiredChecks";
  if (!Number.isSafeInteger(input.number) || input.number <= 0) {
    return yield* new SourceControlRepositoryError({
      operation: op,
      provider: SourceControlProviderKind.make("azure-devops"),
      detail: "Invalid pull request number.",
    });
  }
  yield* requireAzureDevOps(op, input.cwd);
  const id = String(input.number);
  const listed = decodeExpiredPolicyEvaluationIds(
    yield* azJson(op, input.cwd, ["repos", "pr", "policy", "list", "--detect", "true", "--id", id]),
  );
  const ids = yield* decoded(
    op,
    listed === null ? Result.fail("Unreadable policy list.") : Result.succeed(listed),
  );
  yield* Effect.forEach(
    ids,
    (evaluationId) =>
      azJson(op, input.cwd, [
        "repos",
        "pr",
        "policy",
        "queue",
        "--detect",
        "true",
        "--id",
        id,
        `--evaluation-id=${evaluationId}`,
      ]),
    { discard: true },
  );
  return { queued: ids.length };
});
