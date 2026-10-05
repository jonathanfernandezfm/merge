import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  NonNegativeInt,
  TrimmedNonEmptyString,
  type SourceControlRepositoryVisibility,
  type VcsError,
} from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  decodeAzureDevOpsPullRequestJson,
  decodeAzureDevOpsPullRequestListJson,
  type NormalizedAzureDevOpsPullRequestRecord,
} from "./azureDevOpsPullRequests.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

const azureDevOpsCommandErrorFields = {
  operation: Schema.Literal("execute"),
  command: Schema.Literal("az"),
  cwd: Schema.String,
  argumentCount: NonNegativeInt,
  cause: Schema.Defect(),
};

export class AzureDevOpsCliUnavailableError extends Schema.TaggedError<AzureDevOpsCliUnavailableError>()(
  "AzureDevOpsCliUnavailableError",
  azureDevOpsCommandErrorFields,
) {
  get detail(): string {
    return "Azure CLI (`az`) with the Azure DevOps extension is required but not available on PATH.";
  }

  override get message(): string {
    return `Azure DevOps CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class AzureDevOpsCliAuthenticationError extends Schema.TaggedError<AzureDevOpsCliAuthenticationError>()(
  "AzureDevOpsCliAuthenticationError",
  azureDevOpsCommandErrorFields,
) {
  get detail(): string {
    return "Azure DevOps CLI is not authenticated. Run `az devops login` and retry.";
  }

  override get message(): string {
    return `Azure DevOps CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class AzureDevOpsCliRateLimitError extends Schema.TaggedError<AzureDevOpsCliRateLimitError>()(
  "AzureDevOpsCliRateLimitError",
  azureDevOpsCommandErrorFields,
) {
  get detail(): string {
    return "Azure DevOps API rate limit exceeded.";
  }

  override get message(): string {
    return `Azure DevOps CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class AzureDevOpsPullRequestNotFoundError extends Schema.TaggedError<AzureDevOpsPullRequestNotFoundError>()(
  "AzureDevOpsPullRequestNotFoundError",
  azureDevOpsCommandErrorFields,
) {
  get detail(): string {
    return "Pull request not found. Check the PR number or URL and try again.";
  }

  override get message(): string {
    return `Azure DevOps CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class AzureDevOpsCommandFailedError extends Schema.TaggedError<AzureDevOpsCommandFailedError>()(
  "AzureDevOpsCommandFailedError",
  azureDevOpsCommandErrorFields,
) {
  get detail(): string {
    return "Azure DevOps CLI command failed.";
  }

  override get message(): string {
    return `Azure DevOps CLI failed in ${this.operation}: ${this.detail}`;
  }

  static fromVcsError(
    context: {
      readonly operation: "execute";
      readonly command: "az";
      readonly cwd: string;
      readonly argumentCount: number;
    },
    cause: VcsError,
  ): AzureDevOpsCliError {
    const fields = { ...context, cause };

    if (
      cause._tag === "VcsProcessSpawnError" &&
      cause.cause instanceof PlatformError.PlatformError &&
      cause.cause.reason._tag === "NotFound" &&
      cause.cause.reason.pathOrDescriptor !== context.cwd &&
      cause.cause.reason.syscall !== "chdir"
    ) {
      return new AzureDevOpsCliUnavailableError(fields);
    }

    if (cause._tag === "VcsProcessExitError") {
      if (cause.failureKind === "authentication") {
        return new AzureDevOpsCliAuthenticationError(fields);
      }
      if (cause.failureKind === "rate-limited") {
        return new AzureDevOpsCliRateLimitError(fields);
      }
      if (cause.failureKind === "not-found") {
        return new AzureDevOpsPullRequestNotFoundError(fields);
      }
    }

    return new AzureDevOpsCommandFailedError(fields);
  }
}

const azureDevOpsDecodeErrorFields = {
  command: Schema.Literal("az"),
  cwd: Schema.String,
  outputLength: NonNegativeInt,
  cause: Schema.Defect(),
};

export class AzureDevOpsPullRequestListDecodeError extends Schema.TaggedError<AzureDevOpsPullRequestListDecodeError>()(
  "AzureDevOpsPullRequestListDecodeError",
  {
    operation: Schema.Literal("listPullRequests"),
    ...azureDevOpsDecodeErrorFields,
  },
) {
  get detail(): string {
    return "Azure DevOps CLI returned invalid PR list JSON.";
  }

  override get message(): string {
    return `Azure DevOps CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class AzureDevOpsPullRequestDecodeError extends Schema.TaggedError<AzureDevOpsPullRequestDecodeError>()(
  "AzureDevOpsPullRequestDecodeError",
  {
    operation: Schema.Literal("getPullRequest"),
    ...azureDevOpsDecodeErrorFields,
  },
) {
  get detail(): string {
    return "Azure DevOps CLI returned invalid pull request JSON.";
  }

  override get message(): string {
    return `Azure DevOps CLI failed in ${this.operation}: ${this.detail}`;
  }
}

const AzureDevOpsRepositoryDecodeOperation = Schema.Literals([
  "getRepositoryCloneUrls",
  "getDefaultBranch",
  "createRepository",
  "listWorkItemFamily",
  "listWorkItemStates",
  "updateWorkItem",
  "createChildWorkItem",
]);

export class AzureDevOpsRepositoryDecodeError extends Schema.TaggedError<AzureDevOpsRepositoryDecodeError>()(
  "AzureDevOpsRepositoryDecodeError",
  {
    operation: AzureDevOpsRepositoryDecodeOperation,
    ...azureDevOpsDecodeErrorFields,
  },
) {
  get detail(): string {
    return "Azure DevOps CLI returned invalid repository JSON.";
  }

  override get message(): string {
    return `Azure DevOps CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export const AzureDevOpsCliError = Schema.Union([
  AzureDevOpsCliUnavailableError,
  AzureDevOpsCliAuthenticationError,
  AzureDevOpsCliRateLimitError,
  AzureDevOpsPullRequestNotFoundError,
  AzureDevOpsCommandFailedError,
  AzureDevOpsPullRequestListDecodeError,
  AzureDevOpsPullRequestDecodeError,
  AzureDevOpsRepositoryDecodeError,
]);
export type AzureDevOpsCliError = typeof AzureDevOpsCliError.Type;

export interface AzureDevOpsRepositoryCloneUrls {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
}

export class AzureDevOpsCli extends Context.Service<
  AzureDevOpsCli,
  {
    readonly execute: (input: {
      readonly cwd: string;
      readonly args: ReadonlyArray<string>;
      readonly timeoutMs?: number;
      readonly maxOutputBytes?: number;
    }) => Effect.Effect<VcsProcess.VcsProcessOutput, AzureDevOpsCliError>;

    readonly listPullRequests: (input: {
      readonly cwd: string;
      readonly headSelector: string;
      readonly source?: SourceControlProvider.SourceControlRefSelector;
      readonly state: "open" | "closed" | "merged" | "all";
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<NormalizedAzureDevOpsPullRequestRecord>, AzureDevOpsCliError>;

    readonly getPullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
    }) => Effect.Effect<NormalizedAzureDevOpsPullRequestRecord, AzureDevOpsCliError>;

    readonly getRepositoryCloneUrls: (input: {
      readonly cwd: string;
      readonly repository: string;
    }) => Effect.Effect<AzureDevOpsRepositoryCloneUrls, AzureDevOpsCliError>;

    readonly createRepository: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly visibility: SourceControlRepositoryVisibility;
    }) => Effect.Effect<AzureDevOpsRepositoryCloneUrls, AzureDevOpsCliError>;

    readonly createPullRequest: (input: {
      readonly cwd: string;
      readonly baseBranch: string;
      readonly headSelector: string;
      readonly source?: SourceControlProvider.SourceControlRefSelector;
      readonly target?: SourceControlProvider.SourceControlRefSelector;
      readonly title: string;
      readonly bodyFile: string;
      readonly workItemIds?: ReadonlyArray<number>;
    }) => Effect.Effect<void, AzureDevOpsCliError>;

    /** The work item and its direct children, without removed ones. */
    readonly listWorkItemFamily: (input: {
      readonly cwd: string;
      readonly id: number;
    }) => Effect.Effect<
      ReadonlyArray<SourceControlProvider.SourceControlWorkItem>,
      AzureDevOpsCliError
    >;

    readonly listWorkItemStates: (input: {
      readonly cwd: string;
      readonly project: string;
      readonly type: string;
    }) => Effect.Effect<
      ReadonlyArray<SourceControlProvider.SourceControlWorkItemState>,
      AzureDevOpsCliError
    >;

    readonly updateWorkItem: (input: {
      readonly cwd: string;
      readonly id: number;
      readonly state?: string;
      readonly assignToMe?: boolean;
    }) => Effect.Effect<void, AzureDevOpsCliError>;

    /** Creates the item in the parent's project, area and iteration, then links it as a child. */
    readonly createChildWorkItem: (input: {
      readonly cwd: string;
      readonly parentId: number;
      readonly type: string;
      readonly title: string;
    }) => Effect.Effect<{ readonly id: number }, AzureDevOpsCliError>;

    readonly getDefaultBranch: (input: {
      readonly cwd: string;
    }) => Effect.Effect<string | null, AzureDevOpsCliError>;

    readonly checkoutPullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
      readonly remoteName?: string;
    }) => Effect.Effect<void, AzureDevOpsCliError>;
  }
>()("merge-agent/sourceControl/AzureDevOpsCli") {}

function normalizeChangeRequestId(reference: string): string {
  const trimmed = reference.trim().replace(/^#/, "");
  const urlMatch = /(?:pullrequest|pull-request|pull|_pulls?)\/(\d+)(?:\D.*)?$/i.exec(trimmed);
  return urlMatch?.[1] ?? trimmed;
}

function toAzureStatus(state: "open" | "closed" | "merged" | "all"): string {
  switch (state) {
    case "open":
      return "active";
    case "closed":
      return "abandoned";
    case "merged":
      return "completed";
    case "all":
      return "all";
  }
}

const RawAzureDevOpsRepositorySchema = Schema.Struct({
  name: TrimmedNonEmptyString,
  webUrl: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
  project: Schema.optional(
    Schema.Struct({
      name: TrimmedNonEmptyString,
    }),
  ),
  defaultBranch: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawAzureDevOpsWorkItemsSchema = Schema.Array(
  Schema.Struct({
    id: Schema.Number,
    fields: Schema.Struct({
      "System.Title": Schema.optional(Schema.String),
      "System.WorkItemType": Schema.optional(Schema.String),
      "System.State": Schema.optional(Schema.String),
      "System.Parent": Schema.optional(Schema.Number),
      "System.AssignedTo": Schema.optional(Schema.Struct({ displayName: Schema.String })),
      "System.TeamProject": Schema.optional(Schema.String),
      "System.Description": Schema.optional(Schema.String),
      "Microsoft.VSTS.Common.AcceptanceCriteria": Schema.optional(Schema.String),
      "Microsoft.VSTS.TCM.ReproSteps": Schema.optional(Schema.String),
      "System.IterationPath": Schema.optional(Schema.String),
      "Microsoft.VSTS.Common.Priority": Schema.optional(Schema.Number),
      "System.Tags": Schema.optional(Schema.String),
      "System.CreatedDate": Schema.optional(Schema.String),
      "System.ChangedDate": Schema.optional(Schema.String),
      "Microsoft.VSTS.Common.StateChangeDate": Schema.optional(Schema.String),
    }),
    url: Schema.optional(Schema.String),
  }),
);

const RawAzureDevOpsWorkItemTypeStatesSchema = Schema.Struct({
  value: Schema.Array(Schema.Struct({ name: TrimmedNonEmptyString, category: Schema.String })),
});

const RawAzureDevOpsCreatedWorkItemSchema = Schema.Struct({ id: Schema.Number });

const RawAzureDevOpsWorkItemPlacementSchema = Schema.Struct({
  fields: Schema.Struct({
    "System.TeamProject": TrimmedNonEmptyString,
    "System.AreaPath": Schema.optional(Schema.String),
    "System.IterationPath": Schema.optional(Schema.String),
  }),
});

const AZURE_STATE_CATEGORIES: Readonly<
  Record<string, SourceControlProvider.SourceControlWorkItemState["category"]>
> = {
  Proposed: "proposed",
  InProgress: "in-progress",
  Resolved: "resolved",
  Completed: "completed",
  Removed: "removed",
};

function nonEmpty(value: string | undefined): string | null {
  return value !== undefined && value.trim().length > 0 ? value : null;
}

function workItemDetails(
  fields: (typeof RawAzureDevOpsWorkItemsSchema.Type)[number]["fields"],
): SourceControlProvider.SourceControlWorkItemDetails {
  const criteria = nonEmpty(fields["Microsoft.VSTS.Common.AcceptanceCriteria"]);
  const repro = nonEmpty(fields["Microsoft.VSTS.TCM.ReproSteps"]);
  const iteration = nonEmpty(fields["System.IterationPath"]);
  // An iteration at the project root is "no sprint", not a sprint named after the project.
  const sprint = iteration?.includes("\\") ? (iteration.split("\\").at(-1) ?? null) : null;
  return {
    descriptionHtml: nonEmpty(fields["System.Description"]),
    criteriaHtml: criteria ?? repro,
    criteriaLabel: criteria === null && repro !== null ? "Repro steps" : "Acceptance criteria",
    sprint,
    priority: fields["Microsoft.VSTS.Common.Priority"] ?? null,
    tags: (fields["System.Tags"] ?? "")
      .split(";")
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0),
    createdAt: fields["System.CreatedDate"] ?? null,
    updatedAt: fields["System.ChangedDate"] ?? null,
    stateChangedAt: fields["Microsoft.VSTS.Common.StateChangeDate"] ?? null,
  };
}

/** `…/{project}/_apis/wit/workItems/{id}` is the REST resource; the web page lives beside it. */
export function workItemWebUrl(apiUrl: string | undefined): string | null {
  if (apiUrl === undefined) return null;
  const webUrl = apiUrl.replace(/\/_apis\/wit\/workItems\/(\d+)$/iu, "/_workitems/edit/$1");
  return webUrl === apiUrl ? null : webUrl;
}

function normalizeDefaultBranch(value: string | null | undefined): string | null {
  const trimmed = value?.trim().replace(/^refs\/heads\//, "") ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeRepositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawAzureDevOpsRepositorySchema>,
): AzureDevOpsRepositoryCloneUrls {
  const projectName = raw.project?.name.trim();
  return {
    nameWithOwner: projectName ? `${projectName}/${raw.name}` : raw.name,
    url: raw.remoteUrl,
    sshUrl: raw.sshUrl,
  };
}

function parseRepositorySpecifier(repository: string): {
  readonly project: string | null;
  readonly name: string;
} {
  const parts: Array<string> = [];
  for (const part of repository.split("/")) {
    const trimmed = part.trim();
    if (trimmed.length > 0) {
      parts.push(trimmed);
    }
  }
  return {
    project: parts.length > 1 ? (parts.at(-2) ?? null) : null,
    name: parts.at(-1) ?? repository.trim(),
  };
}

function decodeAzureDevOpsJson<S extends Schema.Top>(
  raw: string,
  schema: S,
  operation: typeof AzureDevOpsRepositoryDecodeOperation.Type,
  cwd: string,
): Effect.Effect<S["Type"], AzureDevOpsRepositoryDecodeError, S["DecodingServices"]> {
  return Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
    Effect.mapError(
      (cause) =>
        new AzureDevOpsRepositoryDecodeError({
          operation,
          command: "az",
          cwd,
          outputLength: raw.length,
          cause,
        }),
    ),
  );
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;

  const execute: AzureDevOpsCli["Service"]["execute"] = (input) =>
    process
      .run({
        operation: "AzureDevOpsCli.execute",
        command: "az",
        args: input.args,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(input.maxOutputBytes === undefined ? {} : { maxOutputBytes: input.maxOutputBytes }),
      })
      .pipe(
        Effect.mapError((error) =>
          AzureDevOpsCommandFailedError.fromVcsError(
            {
              operation: "execute",
              command: "az",
              cwd: input.cwd,
              argumentCount: input.args.length,
            },
            error,
          ),
        ),
      );

  const executeJson = (input: Parameters<AzureDevOpsCli["Service"]["execute"]>[0]) =>
    execute({
      ...input,
      args: [...input.args, "--only-show-errors", "--output", "json"],
    });

  return AzureDevOpsCli.of({
    execute,
    listPullRequests: (input) =>
      executeJson({
        cwd: input.cwd,
        args: [
          "repos",
          "pr",
          "list",
          "--detect",
          "true",
          "--source-branch",
          // `az` puts this in the query string unencoded, so a `#` in the
          // branch (`feature/#123-x`) truncates the filter and matches nothing.
          encodeURIComponent(SourceControlProvider.sourceBranch(input)),
          "--status",
          toAzureStatus(input.state),
          "--top",
          String(input.limit ?? 20),
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : Effect.sync(() => decodeAzureDevOpsPullRequestListJson(raw)).pipe(
                Effect.flatMap((decoded) => {
                  if (!Result.isSuccess(decoded)) {
                    return Effect.fail(
                      new AzureDevOpsPullRequestListDecodeError({
                        operation: "listPullRequests",
                        command: "az",
                        cwd: input.cwd,
                        outputLength: raw.length,
                        cause: decoded.failure,
                      }),
                    );
                  }

                  return Effect.succeed(decoded.success);
                }),
              ),
        ),
      ),
    getPullRequest: (input) =>
      executeJson({
        cwd: input.cwd,
        args: [
          "repos",
          "pr",
          "show",
          "--detect",
          "true",
          "--id",
          normalizeChangeRequestId(input.reference),
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          Effect.sync(() => decodeAzureDevOpsPullRequestJson(raw)).pipe(
            Effect.flatMap((decoded) => {
              if (!Result.isSuccess(decoded)) {
                return Effect.fail(
                  new AzureDevOpsPullRequestDecodeError({
                    operation: "getPullRequest",
                    command: "az",
                    cwd: input.cwd,
                    outputLength: raw.length,
                    cause: decoded.failure,
                  }),
                );
              }

              return Effect.succeed(decoded.success);
            }),
          ),
        ),
      ),
    getRepositoryCloneUrls: (input) =>
      executeJson({
        cwd: input.cwd,
        args: ["repos", "show", "--detect", "true", "--repository", input.repository],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeAzureDevOpsJson(
            raw,
            RawAzureDevOpsRepositorySchema,
            "getRepositoryCloneUrls",
            input.cwd,
          ),
        ),
        Effect.map(normalizeRepositoryCloneUrls),
      ),
    createRepository: (input) => {
      const repository = parseRepositorySpecifier(input.repository);
      // Azure Repos access is governed by project/organization permissions.
      // `az repos create` does not expose a per-repository visibility flag, so
      // the generic source-control visibility input is intentionally not
      // translated into CLI args for this provider.
      return executeJson({
        cwd: input.cwd,
        args: [
          "repos",
          "create",
          "--detect",
          "true",
          "--name",
          repository.name,
          ...(repository.project ? ["--project", repository.project] : []),
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeAzureDevOpsJson(raw, RawAzureDevOpsRepositorySchema, "createRepository", input.cwd),
        ),
        Effect.map(normalizeRepositoryCloneUrls),
      );
    },
    createPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "repos",
          "pr",
          "create",
          "--only-show-errors",
          "--detect",
          "true",
          "--target-branch",
          input.target?.refName ?? input.baseBranch,
          "--source-branch",
          SourceControlProvider.sourceBranch(input),
          "--title",
          input.title,
          "--description",
          `@${input.bodyFile}`,
          ...(input.workItemIds && input.workItemIds.length > 0
            ? ["--work-items", ...input.workItemIds.map(String)]
            : []),
        ],
      }).pipe(Effect.asVoid),
    listWorkItemFamily: (input) =>
      executeJson({
        cwd: input.cwd,
        args: [
          "boards",
          "query",
          "--detect",
          "true",
          "--wiql",
          `SELECT [System.Id], [System.Title], [System.WorkItemType], [System.State], [System.Parent], [System.AssignedTo], [System.TeamProject], [System.Description], [Microsoft.VSTS.Common.AcceptanceCriteria], [Microsoft.VSTS.TCM.ReproSteps], [System.IterationPath], [Microsoft.VSTS.Common.Priority], [System.Tags], [System.CreatedDate], [System.ChangedDate], [Microsoft.VSTS.Common.StateChangeDate] FROM WorkItems WHERE ([System.Id] = ${input.id} OR [System.Parent] = ${input.id}) AND [System.State] <> 'Removed'`,
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : decodeAzureDevOpsJson(
                raw,
                RawAzureDevOpsWorkItemsSchema,
                "listWorkItemFamily",
                input.cwd,
              ),
        ),
        Effect.map((items) =>
          items.map((item) => ({
            id: item.id,
            title: item.fields["System.Title"] ?? "",
            type: item.fields["System.WorkItemType"] ?? null,
            state: item.fields["System.State"] ?? null,
            parentId: item.fields["System.Parent"] ?? null,
            assignedTo: item.fields["System.AssignedTo"]?.displayName ?? null,
            project: item.fields["System.TeamProject"] ?? null,
            url: workItemWebUrl(item.url),
            // Children's long text would only inflate every panel read.
            ...(item.id === input.id ? { details: workItemDetails(item.fields) } : {}),
          })),
        ),
      ),
    listWorkItemStates: (input) =>
      executeJson({
        cwd: input.cwd,
        args: [
          "devops",
          "invoke",
          "--detect",
          "true",
          "--area",
          "wit",
          "--resource",
          "workItemTypeStates",
          "--route-parameters",
          `project=${input.project}`,
          `type=${input.type}`,
        ],
      }).pipe(
        Effect.flatMap((result) =>
          decodeAzureDevOpsJson(
            result.stdout.trim(),
            RawAzureDevOpsWorkItemTypeStatesSchema,
            "listWorkItemStates",
            input.cwd,
          ),
        ),
        Effect.map((raw) =>
          raw.value.flatMap((state) => {
            const category = AZURE_STATE_CATEGORIES[state.category];
            return category === undefined || category === "removed"
              ? []
              : [{ name: state.name, category }];
          }),
        ),
      ),
    updateWorkItem: (input) =>
      executeJson({
        cwd: input.cwd,
        args: [
          "boards",
          "work-item",
          "update",
          "--detect",
          "true",
          "--id",
          String(input.id),
          ...(input.state === undefined ? [] : [`--state=${input.state}`]),
          ...(input.assignToMe === true ? ["--assigned-to", "me"] : []),
        ],
      }).pipe(Effect.asVoid),
    createChildWorkItem: (input) =>
      Effect.gen(function* () {
        const parent = yield* executeJson({
          cwd: input.cwd,
          args: [
            "boards",
            "work-item",
            "show",
            "--detect",
            "true",
            "--id",
            // No `--fields`: the CLI always sends `$expand`, which the API rejects with it.
            String(input.parentId),
          ],
        }).pipe(
          Effect.flatMap((result) =>
            decodeAzureDevOpsJson(
              result.stdout.trim(),
              RawAzureDevOpsWorkItemPlacementSchema,
              "createChildWorkItem",
              input.cwd,
            ),
          ),
        );
        const { fields } = parent;
        const created = yield* executeJson({
          cwd: input.cwd,
          args: [
            "boards",
            "work-item",
            "create",
            "--detect",
            "true",
            "--project",
            fields["System.TeamProject"],
            "--type",
            input.type,
            // `=` keeps a title starting with `-` from being read as a flag.
            `--title=${input.title}`,
            ...(fields["System.AreaPath"] ? ["--area", fields["System.AreaPath"]] : []),
            ...(fields["System.IterationPath"]
              ? ["--iteration", fields["System.IterationPath"]]
              : []),
          ],
        }).pipe(
          Effect.flatMap((result) =>
            decodeAzureDevOpsJson(
              result.stdout.trim(),
              RawAzureDevOpsCreatedWorkItemSchema,
              "createChildWorkItem",
              input.cwd,
            ),
          ),
        );
        yield* executeJson({
          cwd: input.cwd,
          args: [
            "boards",
            "work-item",
            "relation",
            "add",
            "--detect",
            "true",
            "--id",
            String(created.id),
            "--relation-type",
            "parent",
            "--target-id",
            String(input.parentId),
          ],
        });
        return { id: created.id };
      }),
    getDefaultBranch: (input) =>
      executeJson({
        cwd: input.cwd,
        args: ["repos", "show", "--detect", "true"],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeAzureDevOpsJson(raw, RawAzureDevOpsRepositorySchema, "getDefaultBranch", input.cwd),
        ),
        Effect.map((repo) => normalizeDefaultBranch(repo.defaultBranch)),
      ),
    checkoutPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "repos",
          "pr",
          "checkout",
          "--only-show-errors",
          "--detect",
          "true",
          "--id",
          normalizeChangeRequestId(input.reference),
          "--remote-name",
          input.remoteName ?? "origin",
        ],
      }).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(AzureDevOpsCli, make);
