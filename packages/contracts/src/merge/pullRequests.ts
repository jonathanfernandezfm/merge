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
