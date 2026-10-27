import {
  SourceControlProviderKind,
  SourceControlRepositoryError,
  type RequeueExpiredChecksInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

import { azJson, decoded, requireAzureDevOps } from "../workItems/workItems.ts";

const decodeEvaluationList = decodeJsonResult(
  Schema.Union([
    Schema.Array(Schema.Unknown),
    Schema.Struct({ value: Schema.Array(Schema.Unknown) }),
  ]),
);
const decodeEvaluation = Schema.decodeUnknownExit(
  Schema.Struct({
    evaluationId: Schema.optional(Schema.NullOr(Schema.String)),
    context: Schema.optional(
      Schema.NullOr(Schema.Struct({ isExpired: Schema.optional(Schema.NullOr(Schema.Boolean)) })),
    ),
  }),
);

/**
 * Evaluation ids of the expired policies in a `az repos pr policy list` answer. The ADO package
 * has the same reader for its auto-complete hook; it exports nothing the server can import.
 */
export function decodeExpiredEvaluationIds(raw: string) {
  const list = decodeEvaluationList(raw.trim().length === 0 ? "[]" : raw);
  if (!Result.isSuccess(list)) return Result.fail(list.failure);
  const entries = "value" in list.success ? list.success.value : list.success;
  const ids: string[] = [];
  for (const entry of entries) {
    const evaluation = decodeEvaluation(entry);
    if (Exit.isFailure(evaluation)) continue;
    const id = evaluation.value.evaluationId?.trim();
    if (id && evaluation.value.context?.isExpired === true) ids.push(id);
  }
  return Result.succeed(ids);
}

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
  const ids = yield* decoded(
    op,
    decodeExpiredEvaluationIds(
      yield* azJson(op, input.cwd, [
        "repos",
        "pr",
        "policy",
        "list",
        "--detect",
        "true",
        "--id",
        id,
      ]),
    ),
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
