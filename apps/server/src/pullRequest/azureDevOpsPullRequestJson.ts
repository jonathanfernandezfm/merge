import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestActor,
  PullRequestCheck,
  PullRequestComment,
  PullRequestMergeMethod,
  PullRequestMergeability,
  PullRequestReviewDecision,
  PullRequestReviewThread,
  PullRequestState,
} from "@t3tools/contracts";
import { TrimmedNonEmptyString } from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

import { azureDevOpsPullRequestWebUrl } from "../sourceControl/azureDevOpsPullRequests.ts";

/**
 * Azure's enums are decoded as plain strings and normalized here, in the same tolerant style as
 * the other hosts: a new merge status must not fail a whole payload. Every field beyond the
 * identity is optional, because `az repos pr` returns rather more or less of the REST object
 * depending on the command.
 */
const RawIdentitySchema = Schema.Struct({
  displayName: Schema.optional(Schema.NullOr(Schema.String)),
  /** An email or UPN, which is what `az account show` reports for the signed-in user. */
  uniqueName: Schema.optional(Schema.NullOr(Schema.String)),
  imageUrl: Schema.optional(Schema.NullOr(Schema.String)),
});

/**
 * A reviewer is an identity plus where it stands. Azure's vote is 10 approved, 5 approved with
 * suggestions, 0 no vote, -5 waiting for the author and -10 rejected.
 */
const RawReviewerSchema = Schema.Struct({
  ...RawIdentitySchema.fields,
  vote: Schema.optional(Schema.NullOr(Schema.Number)),
  isRequired: Schema.optional(Schema.NullOr(Schema.Boolean)),
});

const RawPullRequestSchema = Schema.Struct({
  pullRequestId: Schema.Int,
  title: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  isDraft: Schema.optional(Schema.NullOr(Schema.Boolean)),
  /**
   * Who armed auto-complete, which is the only thing Azure says about it: the field carries an
   * identity while the pull request is set to complete on its own, and Azure leaves it out
   * entirely once nobody has. So its presence is the answer, and there is no third state.
   */
  autoCompleteSetBy: Schema.optional(Schema.NullOr(RawIdentitySchema)),
  completionOptions: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        mergeStrategy: Schema.optional(Schema.NullOr(Schema.String)),
        squashMerge: Schema.optional(Schema.NullOr(Schema.Boolean)),
      }),
    ),
  ),
  mergeStatus: Schema.optional(Schema.NullOr(Schema.String)),
  createdBy: Schema.optional(Schema.NullOr(RawIdentitySchema)),
  reviewers: Schema.optional(Schema.NullOr(Schema.Array(RawReviewerSchema))),
  // Required, and required to be non-empty: the wire contract will not carry a change request
  // without a branch or a created time, so a row missing one is skipped rather than breaking the
  // response it travels in.
  sourceRefName: TrimmedNonEmptyString,
  targetRefName: TrimmedNonEmptyString,
  creationDate: TrimmedNonEmptyString,
  closedDate: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  repository: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        name: Schema.optional(Schema.NullOr(Schema.String)),
        webUrl: Schema.optional(Schema.NullOr(Schema.String)),
        project: Schema.optional(
          Schema.NullOr(Schema.Struct({ name: Schema.optional(Schema.NullOr(Schema.String)) })),
        ),
      }),
    ),
  ),
  _links: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        web: Schema.optional(
          Schema.NullOr(Schema.Struct({ href: Schema.optional(Schema.String) })),
        ),
      }),
    ),
  ),
});

const RawFilePositionSchema = Schema.optional(
  Schema.NullOr(Schema.Struct({ line: Schema.optional(Schema.NullOr(Schema.Number)) })),
);

/** A pull request thread, which is how Azure keeps its conversation. */
const RawThreadSchema = Schema.Struct({
  id: Schema.Int,
  isDeleted: Schema.optional(Schema.NullOr(Schema.Boolean)),
  /** `active` and `pending` are open; `fixed`, `closed`, `byDesign` and `wontFix` resolve it. */
  status: Schema.optional(Schema.NullOr(Schema.String)),
  threadContext: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        filePath: Schema.optional(Schema.NullOr(Schema.String)),
        /** Where the thread sits in the changed file; `leftFileStart` on a removed line. */
        rightFileStart: RawFilePositionSchema,
        leftFileStart: RawFilePositionSchema,
      }),
    ),
  ),
  comments: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          id: Schema.optional(Schema.NullOr(Schema.Int)),
          content: Schema.optional(Schema.NullOr(Schema.String)),
          author: Schema.optional(Schema.NullOr(RawIdentitySchema)),
          publishedDate: Schema.optional(Schema.NullOr(Schema.String)),
          isDeleted: Schema.optional(Schema.NullOr(Schema.Boolean)),
          /** `system` marks the notes Azure writes itself, which are events, not comments. */
          commentType: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  ),
});

const RawThreadPageSchema = Schema.Struct({
  value: Schema.Array(Schema.Unknown),
});

const RawViewerSchema = Schema.Struct({
  user: Schema.optional(
    Schema.NullOr(Schema.Struct({ name: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
});

/**
 * Where a repository lives, in the terms Azure's REST routes address it by. They take the project
 * and the repository as separate route parameters rather than as one path, so the pair travels
 * together rather than as a URL that would have to be taken apart again to use.
 */
export interface AzureDevOpsRepositoryLocation {
  readonly project: string;
  readonly repository: string;
}

export interface AzureDevOpsPullRequest {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: PullRequestActor | null;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly mergeability: PullRequestMergeability;
  readonly createdAt: string;
  /**
   * Azure records no last-touched time on a pull request, so the closing time stands in where
   * there is one and the creation time otherwise. The same fallback the rest of the app uses.
   */
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly body: string;
  readonly reviewRequestLogins: ReadonlyArray<string>;
  readonly reviewers: ReadonlyArray<PullRequestActor>;
  /** What the reviewers' votes add up to, or null when nobody has been asked. */
  readonly reviewDecision: PullRequestReviewDecision | null;
  /** Where this pull request lives, when Azure said enough to work it out. */
  readonly location: AzureDevOpsRepositoryLocation | null;
  /** Whether Azure is set to complete this on its own once its policies pass. */
  readonly autoMergeEnabled: boolean;
  /** The completion strategy Azure stored with auto-complete, where it reported one. */
  readonly autoMergeMethod?: PullRequestMergeMethod;
}

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}

function normalizeRefName(refName: string): string {
  return refName.trim().replace(/^refs\/heads\//, "");
}

/** A login has to compare against `az account show`, which reports an email. */
function toActor(
  raw: Schema.Schema.Type<typeof RawIdentitySchema> | null | undefined,
): PullRequestActor | null {
  const login = trimmed(raw?.uniqueName) ?? trimmed(raw?.displayName);
  return login === null
    ? null
    : { login, name: trimmed(raw?.displayName), avatarUrl: trimmed(raw?.imageUrl) };
}

/**
 * The reviewers' votes read as one decision, the way Azure's own completion gate reads them: any
 * rejection or wait for the author holds the change, a required reviewer who has not approved
 * still owes a review, and otherwise one approval is enough.
 */
function azureDevOpsReviewDecision(
  reviewers: ReadonlyArray<Schema.Schema.Type<typeof RawReviewerSchema>>,
): PullRequestReviewDecision | null {
  if (reviewers.length === 0) return null;
  const voteOf = (reviewer: (typeof reviewers)[number]) => reviewer.vote ?? 0;
  if (reviewers.some((reviewer) => voteOf(reviewer) < 0)) return "changes-requested";
  const required = reviewers.filter((reviewer) => reviewer.isRequired === true);
  if (required.some((reviewer) => voteOf(reviewer) < 5)) return "review-required";
  return reviewers.some((reviewer) => voteOf(reviewer) >= 5) ? "approved" : "review-required";
}

function toState(raw: Schema.Schema.Type<typeof RawPullRequestSchema>): PullRequestState {
  switch (raw.status?.trim().toLowerCase()) {
    case "completed":
      return "merged";
    case "abandoned":
      return "closed";
    default:
      return "open";
  }
}

function toMergeability(value: string | null | undefined): PullRequestMergeability {
  switch (value?.trim().toLowerCase()) {
    case "succeeded":
      return "mergeable";
    case "conflicts":
    case "failure":
    case "rejectedbypolicy":
      return "conflicting";
    default:
      // `queued` and `notSet` mean Azure has not finished checking.
      return "unknown";
  }
}

/**
 * Where a pull request's own repository sits. Taken from what Azure returned rather than from the
 * local remote, whose shape differs between the modern, legacy and SSH forms.
 */
function toLocation(
  raw: Schema.Schema.Type<typeof RawPullRequestSchema>,
): AzureDevOpsRepositoryLocation | null {
  const project = trimmed(raw.repository?.project?.name);
  const repository = trimmed(raw.repository?.name);
  if (project === null || repository === null) return null;
  return { project, repository };
}

function toAutoMergeMethod(
  raw: Schema.Schema.Type<typeof RawPullRequestSchema>,
): PullRequestMergeMethod | undefined {
  if (raw.autoCompleteSetBy == null) return undefined;
  switch (raw.completionOptions?.mergeStrategy?.trim().toLowerCase()) {
    case "squash":
      return "squash";
    case "rebase":
    case "rebasemerge":
      return "rebase";
    case "nofastforward":
      return "merge";
    default:
      return raw.completionOptions?.squashMerge === true ? "squash" : undefined;
  }
}

/**
 * Null when Azure said too little to place the pull request: a row with no browser url and no
 * branch left after its prefix is dropped cannot be rendered or opened, and the wire contract
 * refuses to carry it either.
 */
function toPullRequest(
  raw: Schema.Schema.Type<typeof RawPullRequestSchema>,
): AzureDevOpsPullRequest | null {
  const autoMergeMethod = toAutoMergeMethod(raw);
  const reviewers = (raw.reviewers ?? []).flatMap((reviewer) => {
    const actor = toActor(reviewer);
    return actor === null ? [] : [actor];
  });
  const closedAt = trimmed(raw.closedDate);
  const url = trimmed(
    azureDevOpsPullRequestWebUrl({
      pullRequestId: raw.pullRequestId,
      webLink: raw._links?.web?.href,
      repositoryWebUrl: raw.repository?.webUrl,
      restApiUrl: raw.url,
      projectName: raw.repository?.project?.name,
      repositoryName: raw.repository?.name,
    }),
  );
  const headBranch = trimmed(normalizeRefName(raw.sourceRefName));
  const baseBranch = trimmed(normalizeRefName(raw.targetRefName));
  if (url === null || headBranch === null || baseBranch === null) return null;
  return {
    number: raw.pullRequestId,
    title: raw.title,
    url,
    author: toActor(raw.createdBy),
    headBranch,
    baseBranch,
    state: toState(raw),
    isDraft: raw.isDraft ?? false,
    mergeability: toMergeability(raw.mergeStatus),
    createdAt: raw.creationDate,
    updatedAt: closedAt ?? raw.creationDate,
    closedAt,
    body: raw.description ?? "",
    reviewRequestLogins: reviewers.map((reviewer) => reviewer.login),
    reviewers,
    reviewDecision: azureDevOpsReviewDecision(raw.reviewers ?? []),
    location: toLocation(raw),
    autoMergeEnabled: (raw.autoCompleteSetBy ?? null) !== null,
    ...(autoMergeMethod === undefined ? {} : { autoMergeMethod }),
  };
}

const decodeUnknownList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodePullRequestEntry = Schema.decodeUnknownExit(RawPullRequestSchema);
const decodePullRequest = decodeJsonResult(RawPullRequestSchema);
const decodeThreadPage = decodeJsonResult(RawThreadPageSchema);
const decodeThreadEntry = Schema.decodeUnknownExit(RawThreadSchema);
const decodeViewer = decodeJsonResult(RawViewerSchema);

type DecodeFailure = Cause.Cause<Schema.SchemaError>;

export interface AzureDevOpsPullRequestBatch {
  readonly items: ReadonlyArray<AzureDevOpsPullRequest>;
  /** Zero-based positions of the decoded items in Azure's raw page. */
  readonly rawIndexes: ReadonlyArray<number>;
  /** Rows Azure returned, counted before decoding, so a skipped row cannot hide a next page. */
  readonly rawCount: number;
}

/** Malformed entries are skipped rather than failing the batch, as on the other hosts. */
export function decodePullRequestListJson(
  raw: string,
): Result.Result<AzureDevOpsPullRequestBatch, DecodeFailure> {
  const decoded = decodeUnknownList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const items: AzureDevOpsPullRequest[] = [];
  const rawIndexes: number[] = [];
  for (const [rawIndex, entry] of decoded.success.entries()) {
    const item = decodePullRequestEntry(entry);
    if (Exit.isFailure(item)) continue;
    const pullRequest = toPullRequest(item.value);
    if (pullRequest !== null) {
      items.push(pullRequest);
      rawIndexes.push(rawIndex);
    }
  }
  return Result.succeed({ items, rawIndexes, rawCount: decoded.success.length });
}

/** Null carries "Azure answered, but with too little to use", which the caller reports. */
export function decodePullRequestJson(
  raw: string,
): Result.Result<AzureDevOpsPullRequest | null, DecodeFailure> {
  const decoded = decodePullRequest(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(toPullRequest(decoded.success))
    : Result.fail(decoded.failure);
}

/** `az account show --query user` reports the signed-in account, whose name is an email. */
export function decodeViewerJson(raw: string): Result.Result<string | null, DecodeFailure> {
  const decoded = decodeViewer(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(trimmed(decoded.success.user?.name))
    : Result.fail(decoded.failure);
}

/** The conversation both ways round: one flat timeline, and the threads pinned to a file. */
export interface AzureDevOpsThreads {
  readonly comments: ReadonlyArray<PullRequestComment>;
  readonly threads: ReadonlyArray<PullRequestReviewThread>;
}

/** Statuses that leave a thread open. A thread with no status, or `unknown`, reads as open. */
const OPEN_THREAD_STATUSES = new Set(["active", "pending", "unknown"]);

function isResolvedThreadStatus(status: string | null | undefined): boolean {
  const value = status?.trim().toLowerCase() ?? "";
  return value.length > 0 && !OPEN_THREAD_STATUSES.has(value);
}

function toLine(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Azure keeps its conversation as threads of comments, and every one of them is a remark
 * somebody wrote: a reply under a thread is as much of the conversation as the line that opened
 * it. A thread pinned to a file is a line-level review comment, and is also returned as a review
 * thread carrying its line and whether it was resolved. Azure resolves general threads too, so
 * every comment carries its own thread's resolution.
 *
 * Azure's own notes (`commentType: system`) are events rather than remarks and are dropped.
 *
 * Azure answers the whole thread collection in one response, with no cursor and no page to
 * follow, so what this returns is everything the host has.
 */
export function decodeThreadsJson(raw: string): Result.Result<AzureDevOpsThreads, DecodeFailure> {
  const decoded = decodeThreadPage(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const comments: PullRequestComment[] = [];
  const threads: PullRequestReviewThread[] = [];
  for (const entry of decoded.success.value) {
    const decodedThread = decodeThreadEntry(entry);
    if (Exit.isFailure(decodedThread)) continue;
    const thread = decodedThread.value;
    if (thread.isDeleted === true) continue;
    const path = trimmed(thread.threadContext?.filePath);
    const isResolved = isResolvedThreadStatus(thread.status);
    const threadComments: PullRequestComment[] = [];
    for (const comment of thread.comments ?? []) {
      const publishedDate = trimmed(comment.publishedDate);
      if (
        comment.isDeleted === true ||
        comment.commentType?.trim().toLowerCase() === "system" ||
        (comment.content ?? "").trim().length === 0 ||
        publishedDate === null
      ) {
        continue;
      }
      threadComments.push({
        id: `${thread.id}:${comment.id ?? 0}`,
        kind: path === null ? "issue-comment" : "review-comment",
        author: toActor(comment.author),
        body: comment.content ?? "",
        createdAt: publishedDate,
        url: null,
        path,
        reviewState: null,
        isResolved,
      });
    }
    comments.push(...threadComments);
    // The diff addresses files without the slash Azure leads its paths with.
    const threadPath = toRepositoryPath(path);
    if (threadPath === null || threadComments.length === 0) continue;
    const rightLine = toLine(thread.threadContext?.rightFileStart?.line);
    const leftLine = toLine(thread.threadContext?.leftFileStart?.line);
    const side = rightLine === null && leftLine !== null ? "left" : "right";
    threads.push({
      id: String(thread.id),
      path: threadPath,
      line: side === "left" ? leftLine : rightLine,
      side,
      isResolved,
      // Azure moves a thread along with later pushes rather than marking it outdated.
      isOutdated: false,
      comments: threadComments
        .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map((comment) => ({
          id: comment.id,
          author: comment.author,
          body: comment.body,
          createdAt: comment.createdAt,
          url: comment.url,
        })),
    });
  }
  return Result.succeed({
    comments: comments.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
    threads,
  });
}

/**
 * A branch policy's evaluation on a pull request, as `az repos pr policy list` reports it. Only
 * build and status policies are checks; reviewer, comment and work-item policies are not.
 */
const RawPolicyEvaluationSchema = Schema.Struct({
  /** `queued`, `running`, `approved`, `rejected`, `notApplicable` or `broken`. */
  status: Schema.optional(Schema.NullOr(Schema.String)),
  configuration: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        isBlocking: Schema.optional(Schema.NullOr(Schema.Boolean)),
        isEnabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
        type: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              id: Schema.optional(Schema.NullOr(Schema.String)),
              displayName: Schema.optional(Schema.NullOr(Schema.String)),
            }),
          ),
        ),
        settings: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              displayName: Schema.optional(Schema.NullOr(Schema.String)),
              defaultDisplayName: Schema.optional(Schema.NullOr(Schema.String)),
              statusGenre: Schema.optional(Schema.NullOr(Schema.String)),
              statusName: Schema.optional(Schema.NullOr(Schema.String)),
            }),
          ),
        ),
      }),
    ),
  ),
  context: Schema.optional(
    Schema.NullOr(Schema.Struct({ buildId: Schema.optional(Schema.NullOr(Schema.Number)) })),
  ),
});

/** Azure's own ids for the two policy types that are checks, which survive a renamed type. */
const BUILD_POLICY_TYPE_ID = "0609b952-1397-4640-95ec-e00a01b2c241";
const STATUS_POLICY_TYPE_ID = "cbdc66da-9728-4af8-aada-9a5a32e4a226";

const RawPolicyEvaluationListSchema = Schema.Union([
  Schema.Array(Schema.Unknown),
  Schema.Struct({ value: Schema.Array(Schema.Unknown) }),
]);
const decodePolicyEvaluationList = decodeJsonResult(RawPolicyEvaluationListSchema);
const decodePolicyEvaluationEntry = Schema.decodeUnknownExit(RawPolicyEvaluationSchema);

function toCheckStatus(
  status: string | null | undefined,
  isBlocking: boolean,
): PullRequestCheck["status"] {
  switch (status?.trim().toLowerCase()) {
    case "approved":
      return "success";
    case "notapplicable":
      return "skipped";
    case "rejected":
    case "broken":
      // An optional policy that failed does not hold the merge, which a failing check would say.
      return isBlocking ? "failure" : "neutral";
    default:
      // `queued`, `running`, and anything Azure adds later.
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
): Result.Result<ReadonlyArray<PullRequestCheck>, DecodeFailure> {
  // az prints nothing at all for a pull request no policy applies to.
  const decoded = decodePolicyEvaluationList(raw.length === 0 ? "[]" : raw);
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
    const buildId = evaluation.context?.buildId;
    checks.push({
      name,
      status: toCheckStatus(evaluation.status, isBlocking),
      description: isBlocking ? null : "Optional",
      url:
        isBuild && projectUrl !== null && typeof buildId === "number"
          ? `${projectUrl}/_build/results?buildId=${buildId}`
          : null,
    });
  }
  return Result.succeed(checks);
}

/**
 * One push's worth of a pull request. Azure records every push as an iteration and keys the whole
 * review off them: the changed files, and the marks a reader leaves on those files, both hang
 * from an iteration rather than from the pull request.
 */
const RawIterationSchema = Schema.Struct({
  id: Schema.Int,
  sourceRefCommit: Schema.optional(
    Schema.NullOr(Schema.Struct({ commitId: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
  commonRefCommit: Schema.optional(
    Schema.NullOr(Schema.Struct({ commitId: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
});

const RawIterationPageSchema = Schema.Struct({ value: Schema.Array(Schema.Unknown) });

const RawChangeEntrySchema = Schema.Struct({
  changeType: Schema.optional(Schema.NullOr(Schema.String)),
  sourceServerItem: Schema.optional(Schema.NullOr(Schema.String)),
  /** Where a renamed file came from. Azure states it here on an iteration's changes. */
  originalPath: Schema.optional(Schema.NullOr(Schema.String)),
  item: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        path: Schema.optional(Schema.NullOr(Schema.String)),
        objectId: Schema.optional(Schema.NullOr(Schema.String)),
        originalObjectId: Schema.optional(Schema.NullOr(Schema.String)),
        /** Azure marks a directory this way; a review has nothing to show for one. */
        isFolder: Schema.optional(Schema.NullOr(Schema.Boolean)),
        gitObjectType: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

const RawChangePageSchema = Schema.Struct({
  changeEntries: Schema.Array(Schema.Unknown),
  /** Where the page after this one starts. Azure leaves it out on the last page. */
  nextSkip: Schema.optional(Schema.NullOr(Schema.Number)),
});

const RawItemContentSchema = Schema.Struct({
  content: Schema.optional(Schema.NullOr(Schema.String)),
  /** What Azure makes of the file it is handing over, which is where it says it is not text. */
  contentMetadata: Schema.optional(
    Schema.NullOr(Schema.Struct({ isBinary: Schema.optional(Schema.NullOr(Schema.Boolean)) })),
  ),
});

/** The head and the merge base of one iteration, which is the range its patch is taken over. */
export interface AzureDevOpsIteration {
  readonly id: number;
  readonly headCommit: string;
  readonly mergeBaseCommit: string;
}

/**
 * What one file did across an iteration. `oldPath` differs from `path` only for a rename, which
 * Azure reports by naming the file's previous home rather than as a delete and an add.
 */
export interface AzureDevOpsChangeEntry {
  readonly path: string;
  readonly oldPath: string;
  readonly changeKind: "new" | "deleted" | "change" | "rename-pure" | "rename-changed";
  readonly objectId: string | null;
  readonly originalObjectId: string | null;
}

/**
 * One page of what an iteration changed, and where the next one starts. Azure pages this route
 * rather than answering with the whole change, so a review large enough to be paged is followed
 * to its end instead of being cut off at the first page's worth.
 */
export interface AzureDevOpsChangePage {
  readonly changes: ReadonlyArray<AzureDevOpsChangeEntry>;
  readonly nextSkip: number | null;
}

/** One file's text at one commit, and whether Azure says the text is text at all. */
export interface AzureDevOpsItemContent {
  readonly contents: string;
  readonly isBinary: boolean;
}

const decodeIterationPage = decodeJsonResult(RawIterationPageSchema);
const decodeIterationEntry = Schema.decodeUnknownExit(RawIterationSchema);
const decodeChangePage = decodeJsonResult(RawChangePageSchema);
const decodeChangeEntry = Schema.decodeUnknownExit(RawChangeEntrySchema);
const decodeItemContent = decodeJsonResult(RawItemContentSchema);

/**
 * Azure leads a path with a slash that every other host and every patch omits. Not trimmed like
 * the rest of this payload, since a leading/trailing space is a legal part of a file's name and
 * the patch and viewed mark are keyed by the untrimmed path.
 */
function toRepositoryPath(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const path = value.replace(/^\/+/, "");
  return path.length === 0 ? null : path;
}

/**
 * Azure names a change with one word or two, and a rename arrives either alone or alongside the
 * edit that came with it. Anything it has added since reads as a plain change, which shows the
 * file rather than dropping it from the review.
 */
function toChangeKind(
  raw: string | null | undefined,
  renamed: boolean,
): AzureDevOpsChangeEntry["changeKind"] {
  const parts = new Set(
    (raw ?? "")
      .toLowerCase()
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );
  if (parts.has("delete")) return "deleted";
  if (renamed || parts.has("rename")) return parts.has("edit") ? "rename-changed" : "rename-pure";
  if (parts.has("add")) return "new";
  return "change";
}

export function decodeIterationsJson(
  raw: string,
): Result.Result<ReadonlyArray<AzureDevOpsIteration>, DecodeFailure> {
  const decoded = decodeIterationPage(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const iterations: AzureDevOpsIteration[] = [];
  for (const entry of decoded.success.value) {
    const decodedIteration = decodeIterationEntry(entry);
    if (Exit.isFailure(decodedIteration)) continue;
    const iteration = decodedIteration.value;
    const headCommit = trimmed(iteration.sourceRefCommit?.commitId);
    const mergeBaseCommit = trimmed(iteration.commonRefCommit?.commitId);
    // An iteration Azure cannot place both ends of names no range, and a patch needs both.
    if (headCommit === null || mergeBaseCommit === null) continue;
    iterations.push({ id: iteration.id, headCommit, mergeBaseCommit });
  }
  return Result.succeed(iterations.toSorted((left, right) => left.id - right.id));
}

export function decodeIterationChangesJson(
  raw: string,
): Result.Result<AzureDevOpsChangePage, DecodeFailure> {
  const decoded = decodeChangePage(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const changes: AzureDevOpsChangeEntry[] = [];
  for (const entry of decoded.success.changeEntries) {
    const decodedChange = decodeChangeEntry(entry);
    if (Exit.isFailure(decodedChange)) continue;
    const change = decodedChange.value;
    const path = toRepositoryPath(change.item?.path);
    if (path === null) continue;
    // Azure lists the folders a change touched alongside the files themselves. A review shows
    // files, and a folder has no content to show for either side of one.
    if (change.item?.isFolder === true) continue;
    if ((change.item?.gitObjectType ?? "blob").toLowerCase() !== "blob") continue;
    // Azure names where a renamed file came from in either of two places depending on the route
    // and the version, so both are read and the current path stands in when neither is there.
    const oldPath =
      toRepositoryPath(change.sourceServerItem) ?? toRepositoryPath(change.originalPath) ?? path;
    changes.push({
      path,
      oldPath,
      changeKind: toChangeKind(change.changeType, oldPath !== path),
      objectId: trimmed(change.item?.objectId),
      originalObjectId: trimmed(change.item?.originalObjectId),
    });
  }
  const nextSkip = decoded.success.nextSkip ?? null;
  return Result.succeed({
    changes,
    nextSkip: nextSkip !== null && Number.isSafeInteger(nextSkip) && nextSkip > 0 ? nextSkip : null,
  });
}

/**
 * Azure answers an absent file with an empty body rather than an error, which reads as empty.
 * Whether the bytes are text is Azure's own call, not this decoder's to guess from content.
 */
export function decodeItemContentJson(
  raw: string,
): Result.Result<AzureDevOpsItemContent, DecodeFailure> {
  const decoded = decodeItemContent(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed({
        contents: decoded.success.content ?? "",
        isBinary: decoded.success.contentMetadata?.isBinary === true,
      })
    : Result.fail(decoded.failure);
}
