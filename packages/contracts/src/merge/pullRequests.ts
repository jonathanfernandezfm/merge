import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "../auth.ts";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "../baseSchemas.ts";
import { SourceControlRepositoryError } from "../sourceControl.ts";

/**
 * Description the fork gives an Azure DevOps build policy that expired. Azure resets it to
 * `queued` and never runs it again by itself, so it reads as `action-required`.
 */
export const AZURE_DEVOPS_EXPIRED_CHECK_DESCRIPTION = "Expired. Queue it again in Azure DevOps.";

export const RequeueExpiredChecksInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type RequeueExpiredChecksInput = typeof RequeueExpiredChecksInput.Type;

export const RequeueExpiredChecksResult = Schema.Struct({ queued: NonNegativeInt });
export type RequeueExpiredChecksResult = typeof RequeueExpiredChecksResult.Type;

export const RequeueExpiredChecksError = Schema.Union([
  SourceControlRepositoryError,
  EnvironmentAuthorizationError,
]);

const decodePolicyEvaluationList = Schema.decodeUnknownExit(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Array(Schema.Unknown),
      Schema.Struct({ value: Schema.Array(Schema.Unknown) }),
    ]),
  ),
);
const decodeExpirableEvaluation = Schema.decodeUnknownExit(
  Schema.Struct({
    evaluationId: Schema.optional(Schema.NullOr(Schema.String)),
    context: Schema.optional(
      Schema.NullOr(Schema.Struct({ isExpired: Schema.optional(Schema.NullOr(Schema.Boolean)) })),
    ),
  }),
);

/**
 * Evaluation ids of the expired policies in a `az repos pr policy list` answer, the ones
 * `az repos pr policy queue` must be given to run again. Shared by the ADO package's auto-complete
 * hook and the server's re-queue RPC. Null when the answer is not a policy list.
 */
export function decodeExpiredPolicyEvaluationIds(raw: string): ReadonlyArray<string> | null {
  // az prints nothing at all for a pull request no policy applies to.
  const list = decodePolicyEvaluationList(raw.trim().length === 0 ? "[]" : raw);
  if (list._tag === "Failure") return null;
  // `az repos pr policy list` answers with a bare list; the REST route wraps it in `value`.
  const entries = "value" in list.value ? list.value.value : list.value;
  const ids: string[] = [];
  for (const entry of entries) {
    const evaluation = decodeExpirableEvaluation(entry);
    if (evaluation._tag === "Failure") continue;
    const id = evaluation.value.evaluationId?.trim();
    if (id && evaluation.value.context?.isExpired === true) ids.push(id);
  }
  return ids;
}
