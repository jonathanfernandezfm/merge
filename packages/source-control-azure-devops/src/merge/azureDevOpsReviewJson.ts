import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestCheck,
  PullRequestComment,
  PullRequestReviewDecision,
  PullRequestReviewThread,
} from "@t3tools/contracts";
import { AZURE_DEVOPS_EXPIRED_CHECK_DESCRIPTION } from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

const trimmed = (value: string | null | undefined) => {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
};

const NullableString = Schema.optional(Schema.NullOr(Schema.String));

/**
 * A branch policy's evaluation on a pull request, as `az repos pr policy list` reports it. Only
 * build and status policies are checks; reviewer, comment and work-item policies are not.
 */
const RawPolicyEvaluationSchema = Schema.Struct({
  evaluationId: NullableString,
  /** `queued`, `running`, `approved`, `rejected`, `notApplicable` or `broken`. */
  status: NullableString,
  configuration: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        isBlocking: Schema.optional(Schema.NullOr(Schema.Boolean)),
        isEnabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
        type: Schema.optional(
          Schema.NullOr(Schema.Struct({ id: NullableString, displayName: NullableString })),
        ),
        settings: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              displayName: NullableString,
              defaultDisplayName: NullableString,
              statusGenre: NullableString,
              statusName: NullableString,
            }),
          ),
        ),
      }),
    ),
  ),
  context: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        buildId: Schema.optional(Schema.NullOr(Schema.Number)),
        /** Azure resets an expired build to `queued` and says so only here. */
        isExpired: Schema.optional(Schema.NullOr(Schema.Boolean)),
      }),
    ),
  ),
});

/** Azure's own ids for the two policy types that are checks, which survive a renamed type. */
const BUILD_POLICY_TYPE_ID = "0609b952-1397-4640-95ec-e00a01b2c241";
const STATUS_POLICY_TYPE_ID = "cbdc66da-9728-4af8-aada-9a5a32e4a226";

const decodePolicyEvaluationList = decodeJsonResult(
  Schema.Union([
    Schema.Array(Schema.Unknown),
    Schema.Struct({ value: Schema.Array(Schema.Unknown) }),
  ]),
);
const decodePolicyEvaluationEntry = Schema.decodeUnknownExit(RawPolicyEvaluationSchema);

function toCheckStatus(
  status: string | null | undefined,
  isBlocking: boolean,
  isExpired: boolean,
): PullRequestCheck["status"] {
  const normalized = status?.trim().toLowerCase();
  // An expired build reads `queued` but nothing runs until someone queues it again.
  if (isExpired && (normalized === "queued" || normalized === "running")) {
    return "action-required";
  }
  switch (normalized) {
    case "approved":
      return "success";
    case "notapplicable":
      return "skipped";
    case "rejected":
    case "broken":
      // An optional policy that failed does not hold the merge, which a failing check would say.
      return isBlocking ? "failure" : "neutral";
    default:
      return "pending";
  }
}

/**
 * The build and status policies evaluated on a pull request, read as checks. A build's result
 * page hangs off the project, which the pull request's own web url names.
 */
export function decodePolicyEvaluationsJson(
  raw: string,
  pullRequestUrl: string | null,
): Result.Result<ReadonlyArray<PullRequestCheck>, unknown> {
  // az prints nothing at all for a pull request no policy applies to.
  const decoded = decodePolicyEvaluationList(raw.trim().length === 0 ? "[]" : raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  // `az repos pr policy list` answers with a bare list; the REST route wraps it in `value`.
  const entries = "value" in decoded.success ? decoded.success.value : decoded.success;
  const projectUrl =
    pullRequestUrl !== null && pullRequestUrl.includes("/_git/")
      ? pullRequestUrl.slice(0, pullRequestUrl.indexOf("/_git/"))
      : null;
  const checks: PullRequestCheck[] = [];
  for (const entry of entries) {
    const decodedEvaluation = decodePolicyEvaluationEntry(entry);
    if (Exit.isFailure(decodedEvaluation)) continue;
    const evaluation = decodedEvaluation.value;
    const configuration = evaluation.configuration;
    if (configuration?.isEnabled === false) continue;
    const typeId = trimmed(configuration?.type?.id)?.toLowerCase() ?? null;
    const typeName = trimmed(configuration?.type?.displayName)?.toLowerCase() ?? null;
    const isBuild = typeId === BUILD_POLICY_TYPE_ID || typeName === "build";
    const isStatus = typeId === STATUS_POLICY_TYPE_ID || typeName === "status";
    if (!isBuild && !isStatus) continue;
    const settings = configuration?.settings;
    const statusName = [trimmed(settings?.statusGenre), trimmed(settings?.statusName)]
      .filter((part) => part !== null)
      .join("/");
    const name =
      trimmed(settings?.displayName) ??
      trimmed(settings?.defaultDisplayName) ??
      trimmed(statusName) ??
      trimmed(configuration?.type?.displayName);
    if (name === null) continue;
    // Azure treats a policy as required unless it was configured as optional.
    const isBlocking = configuration?.isBlocking !== false;
    const isExpired = evaluation.context?.isExpired === true;
    const status = toCheckStatus(evaluation.status, isBlocking, isExpired);
    const buildId = evaluation.context?.buildId;
    checks.push({
      name,
      status,
      description:
        status === "action-required"
          ? AZURE_DEVOPS_EXPIRED_CHECK_DESCRIPTION
          : isBlocking
            ? null
            : "Optional",
      url:
        isBuild && projectUrl !== null && typeof buildId === "number"
          ? `${projectUrl}/_build/results?buildId=${buildId}`
          : null,
      required: isBlocking,
    });
  }
  return Result.succeed(checks);
}

/**
 * The evaluations of a `az repos pr policy list` answer that have expired, which are the ones
 * `az repos pr policy queue` has to be given to run again.
 */
export function decodeExpiredPolicyEvaluationIds(
  raw: string,
): Result.Result<ReadonlyArray<string>, unknown> {
  const decoded = decodePolicyEvaluationList(raw.trim().length === 0 ? "[]" : raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const entries = "value" in decoded.success ? decoded.success.value : decoded.success;
  const ids: string[] = [];
  for (const entry of entries) {
    const decodedEvaluation = decodePolicyEvaluationEntry(entry);
    if (Exit.isFailure(decodedEvaluation)) continue;
    const id = trimmed(decodedEvaluation.value.evaluationId);
    if (id !== null && decodedEvaluation.value.context?.isExpired === true) ids.push(id);
  }
  return Result.succeed(ids);
}

/**
 * Azure's vote is 10 approved, 5 approved with suggestions, 0 no vote, -5 waiting for the author
 * and -10 rejected.
 */
const decodeReviewers = decodeJsonResult(
  Schema.Struct({
    reviewers: Schema.optional(
      Schema.NullOr(
        Schema.Array(
          Schema.Struct({
            vote: Schema.optional(Schema.NullOr(Schema.Number)),
            isRequired: Schema.optional(Schema.NullOr(Schema.Boolean)),
          }),
        ),
      ),
    ),
  }),
);

/**
 * The reviewers' votes on `az repos pr show` read as one decision, the way Azure's completion gate
 * reads them: any rejection or wait for the author holds the change, a required reviewer who has
 * not approved still owes a review, and otherwise one approval is enough.
 */
export function decodeReviewDecisionJson(
  raw: string,
): Result.Result<PullRequestReviewDecision | null, unknown> {
  const decoded = decodeReviewers(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const reviewers = decoded.success.reviewers ?? [];
  if (reviewers.length === 0) return Result.succeed(null);
  const voteOf = (reviewer: (typeof reviewers)[number]) => reviewer.vote ?? 0;
  if (reviewers.some((reviewer) => voteOf(reviewer) < 0))
    return Result.succeed("changes-requested");
  if (reviewers.some((reviewer) => reviewer.isRequired === true && voteOf(reviewer) < 5)) {
    return Result.succeed("review-required");
  }
  return Result.succeed(
    reviewers.some((reviewer) => voteOf(reviewer) >= 5) ? "approved" : "review-required",
  );
}

const RawFilePositionSchema = Schema.optional(
  Schema.NullOr(Schema.Struct({ line: Schema.optional(Schema.NullOr(Schema.Number)) })),
);

/** Only what upstream's comment decoder drops: where a thread sits and whether it is resolved. */
const RawThreadSchema = Schema.Struct({
  id: Schema.Int,
  isDeleted: Schema.optional(Schema.NullOr(Schema.Boolean)),
  /** `active` and `pending` are open; `fixed`, `closed`, `byDesign` and `wontFix` resolve it. */
  status: NullableString,
  threadContext: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        filePath: NullableString,
        /** `leftFileStart` is set instead on a removed line. */
        rightFileStart: RawFilePositionSchema,
        leftFileStart: RawFilePositionSchema,
      }),
    ),
  ),
});

const decodeThreadPage = decodeJsonResult(Schema.Struct({ value: Schema.Array(Schema.Unknown) }));
const decodeThreadEntry = Schema.decodeUnknownExit(RawThreadSchema);

/** A thread with no status, or `unknown`, reads as open. */
const OPEN_THREAD_STATUSES = new Set(["active", "pending", "unknown"]);

const toLine = (value: number | null | undefined) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;

/**
 * The file-pinned threads of a `pullRequestThreads` answer. `comments` is upstream's decode of the
 * same answer, whose ids are `<thread>:<comment>`, so both agree on which remarks count.
 */
export function decodeReviewThreadsJson(
  raw: string,
  comments: ReadonlyArray<PullRequestComment>,
): Result.Result<ReadonlyArray<PullRequestReviewThread>, unknown> {
  const decoded = decodeThreadPage(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const commentsByThread = Map.groupBy(comments, (comment) => comment.id.split(":")[0]);
  const threads: PullRequestReviewThread[] = [];
  for (const entry of decoded.success.value) {
    const decodedThread = decodeThreadEntry(entry);
    if (Exit.isFailure(decodedThread)) continue;
    const thread = decodedThread.value;
    if (thread.isDeleted === true) continue;
    // The diff addresses files without the slash Azure leads its paths with.
    const path = trimmed(thread.threadContext?.filePath)?.replace(/^\/+/, "") ?? null;
    const threadComments = commentsByThread.get(String(thread.id)) ?? [];
    if (!path || threadComments.length === 0) continue;
    const rightLine = toLine(thread.threadContext?.rightFileStart?.line);
    const leftLine = toLine(thread.threadContext?.leftFileStart?.line);
    const side = rightLine === null && leftLine !== null ? "left" : "right";
    const status = thread.status?.trim().toLowerCase() ?? "";
    threads.push({
      id: String(thread.id),
      path,
      line: side === "left" ? leftLine : rightLine,
      side,
      isResolved: status.length > 0 && !OPEN_THREAD_STATUSES.has(status),
      // Azure moves a thread along with later pushes rather than marking it outdated.
      isOutdated: false,
      comments: threadComments.map((comment) => ({
        id: comment.id,
        author: comment.author,
        body: comment.body,
        createdAt: comment.createdAt,
        url: comment.url,
      })),
    });
  }
  return Result.succeed(threads);
}
