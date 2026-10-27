import {
  SourceControlProviderKind,
  SourceControlRepositoryError,
  type BranchWorkItems,
  type BranchWorkItemsInput,
  type CreateChildWorkItemInput,
  type LinkBranchWorkItemInput,
  type UpdateWorkItemInput,
  type WorkItemState,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import * as SourceControlProviderRegistry from "../../sourceControl/SourceControlProviderRegistry.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { lookup, requireKnownWorkspace } from "../workspaceGuard.ts";
import {
  branchWorkItemConfigKey,
  decodeCreatedWorkItemJson,
  decodeWorkItemFamilyJson,
  decodeWorkItemPlacementJson,
  decodeWorkItemStatesJson,
  resolveBranchWorkItemId,
  workItemFamilyWiql,
  type WorkItemFamilyMember,
} from "./azureBoards.ts";

const AZURE_DEVOPS = SourceControlProviderKind.make("azure-devops");
const AZ_TIMEOUT_MS = 30_000;
// A type's states change only when an admin edits the process, and every lookup boots `az`.
const STATES_TTL_MS = 60 * 60 * 1000;

const failure = (operation: string, detail: string, cause?: unknown) =>
  new SourceControlRepositoryError({ operation, provider: AZURE_DEVOPS, detail, cause });

/** The provider's own reason (a rejected transition, a missing type) when it gave one. */
const detailOf = (cause: unknown, fallback: string) =>
  typeof cause === "object" && cause !== null && "detail" in cause && String(cause.detail).trim()
    ? String(cause.detail).trim()
    : fallback;

const requireWorkspace = (operation: string, cwd: string) =>
  requireKnownWorkspace(cwd, (cause?: unknown) =>
    failure(operation, "Work items need a known workspace.", cause),
  );

/** Runs `az … --output json` as argv, never through a shell. */
export const azJson = Effect.fn("WorkItems.az")(function* (
  operation: string,
  cwd: string,
  args: ReadonlyArray<string>,
) {
  const process = yield* lookup(VcsProcess.VcsProcess);
  const result = yield* process
    .run({
      operation: `WorkItems.${operation}`,
      command: "az",
      args: [...args, "--only-show-errors", "--output", "json"],
      cwd,
      timeoutMs: AZ_TIMEOUT_MS,
    })
    .pipe(
      Effect.mapError((cause) =>
        failure(operation, detailOf(cause, "Azure CLI could not complete the request."), cause),
      ),
    );
  return result.stdout.trim();
});

export const decoded = <A>(operation: string, result: Result.Result<A, unknown>) =>
  Result.isSuccess(result)
    ? Effect.succeed(result.success)
    : Effect.fail(failure(operation, "Azure CLI returned an unreadable answer.", result.failure));

const readCurrentBranch = Effect.fn("WorkItems.readCurrentBranch")(function* (cwd: string) {
  const git = yield* lookup(GitVcsDriver.GitVcsDriver);
  const result = yield* git
    .execute({
      operation: "WorkItems.readCurrentBranch",
      cwd,
      args: ["symbolic-ref", "--short", "-q", "HEAD"],
      allowNonZeroExit: true,
    })
    .pipe(Effect.orElseSucceed(() => ({ exitCode: 1, stdout: "" })));
  const branch = result.stdout.trim();
  return result.exitCode === 0 && branch.length > 0 ? branch : null;
});

const isAzureDevOps = Effect.fn("WorkItems.isAzureDevOps")(function* (cwd: string) {
  const registry = yield* lookup(SourceControlProviderRegistry.SourceControlProviderRegistry);
  return yield* registry.resolve({ cwd }).pipe(
    Effect.map((provider) => provider.kind === AZURE_DEVOPS),
    Effect.orElseSucceed(() => false),
  );
});

// shortcut: process-wide map, unbounded by key count; fine for a handful of projects and types.
const statesCache = new Map<
  string,
  { readonly at: number; readonly states: ReadonlyArray<WorkItemState> }
>();

const readStates = Effect.fn("WorkItems.readStates")(function* (
  cwd: string,
  project: string,
  type: string,
) {
  // NUL cannot appear in a path, a project name or a work item type.
  const key = [cwd, project, type].join("\u0000");
  const now = yield* Clock.currentTimeMillis;
  const cached = statesCache.get(key);
  if (cached && now - cached.at < STATES_TTL_MS) return cached.states;
  const raw = yield* azJson("listWorkItemStates", cwd, [
    "devops",
    "invoke",
    "--detect",
    "true",
    "--area",
    "wit",
    "--resource",
    "workItemTypeStates",
    "--route-parameters",
    `project=${project}`,
    `type=${type}`,
  ]);
  const states = yield* decoded("listWorkItemStates", decodeWorkItemStatesJson(raw));
  statesCache.set(key, { at: now, states });
  return states;
});

const toWorkItem = ({ project: _project, ...item }: WorkItemFamilyMember) => item;

export const branchWorkItems = Effect.fn("WorkItems.branch")(function* (
  input: BranchWorkItemsInput,
) {
  yield* requireWorkspace("branchWorkItems", input.cwd);
  const supported = yield* isAzureDevOps(input.cwd);
  const branch = yield* readCurrentBranch(input.cwd);
  const empty: BranchWorkItems = {
    branch,
    supported,
    source: null,
    workItemId: null,
    root: null,
    rootDetails: null,
    children: [],
    states: {},
  };
  if (branch === null || !supported) return empty;
  const git = yield* lookup(GitVcsDriver.GitVcsDriver);
  const linked = yield* git
    .readConfigValue(input.cwd, branchWorkItemConfigKey(branch))
    .pipe(Effect.orElseSucceed(() => null));
  const resolved = resolveBranchWorkItemId(branch, linked);
  if (resolved === null) return empty;
  const raw = yield* azJson("listWorkItemFamily", input.cwd, [
    "boards",
    "query",
    "--detect",
    "true",
    "--wiql",
    workItemFamilyWiql(resolved.id),
  ]);
  const family = yield* decoded("listWorkItemFamily", decodeWorkItemFamilyJson(raw, resolved.id));
  const root = family.items.find((item) => item.id === resolved.id) ?? null;
  const types = new Map<string, string>();
  for (const item of family.items) {
    if (item.type && item.project) types.set(item.type, item.project);
  }
  // States only feed the edit menu; a failed lookup must not hide the items.
  const states = yield* Effect.forEach(
    [...types],
    ([type, project]) =>
      readStates(input.cwd, project, type).pipe(
        Effect.map((list) => [type, list] as const),
        Effect.orElseSucceed(() => [type, []] as const),
      ),
    { concurrency: "unbounded" },
  );
  return {
    ...empty,
    source: resolved.source,
    workItemId: resolved.id,
    root: root === null ? null : toWorkItem(root),
    rootDetails: root === null ? null : family.rootDetails,
    children: family.items.filter((item) => item.id !== resolved.id).map(toWorkItem),
    states: Object.fromEntries(states),
  } satisfies BranchWorkItems;
});

export const linkBranchWorkItem = Effect.fn("WorkItems.link")(function* (
  input: LinkBranchWorkItemInput,
) {
  yield* requireWorkspace("linkBranchWorkItem", input.cwd);
  const branch = yield* readCurrentBranch(input.cwd);
  if (branch === null) {
    return yield* failure("linkBranchWorkItem", "Check out a branch to link a work item.");
  }
  const git = yield* lookup(GitVcsDriver.GitVcsDriver);
  const key = branchWorkItemConfigKey(branch);
  yield* git
    .execute({
      operation: "WorkItems.link",
      cwd: input.cwd,
      // `--unset` exits 5 when nothing was linked, which is already the goal.
      args: input.id === null ? ["config", "--unset", key] : ["config", key, String(input.id)],
      allowNonZeroExit: input.id === null,
    })
    .pipe(
      Effect.mapError((cause) =>
        failure("linkBranchWorkItem", detailOf(cause, "The branch could not be updated."), cause),
      ),
    );
});

export const requireAzureDevOps = Effect.fn("WorkItems.requireAzureDevOps")(function* (
  operation: string,
  cwd: string,
) {
  yield* requireWorkspace(operation, cwd);
  if (!(yield* isAzureDevOps(cwd))) {
    return yield* failure(operation, "This needs an Azure DevOps repository.");
  }
});

export const updateWorkItem = Effect.fn("WorkItems.update")(function* (input: UpdateWorkItemInput) {
  yield* requireAzureDevOps("updateWorkItem", input.cwd);
  if (input.state === undefined && input.assignToMe !== true) return;
  yield* azJson("updateWorkItem", input.cwd, [
    "boards",
    "work-item",
    "update",
    "--detect",
    "true",
    "--id",
    String(input.id),
    // `=` keeps a value starting with `-` from being read as a flag.
    ...(input.state === undefined ? [] : [`--state=${input.state}`]),
    ...(input.assignToMe === true ? ["--assigned-to", "me"] : []),
  ]);
});

/** Creates the item in the parent's project, area and iteration, then links it as a child. */
export const createChildWorkItem = Effect.fn("WorkItems.createChild")(function* (
  input: CreateChildWorkItemInput,
) {
  const op = "createChildWorkItem";
  yield* requireAzureDevOps(op, input.cwd);
  const parent = yield* decoded(
    op,
    decodeWorkItemPlacementJson(
      yield* azJson(op, input.cwd, [
        "boards",
        "work-item",
        "show",
        "--detect",
        "true",
        // No `--fields`: the CLI always sends `$expand`, which the API rejects with it.
        "--id",
        String(input.parentId),
      ]),
    ),
  );
  const created = yield* decoded(
    op,
    decodeCreatedWorkItemJson(
      yield* azJson(op, input.cwd, [
        "boards",
        "work-item",
        "create",
        "--detect",
        "true",
        `--project=${parent.project}`,
        `--type=${input.type}`,
        `--title=${input.title}`,
        ...(parent.area ? [`--area=${parent.area}`] : []),
        ...(parent.iteration ? [`--iteration=${parent.iteration}`] : []),
      ]),
    ),
  );
  yield* azJson(op, input.cwd, [
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
  ]);
  return { id: created.id };
});
