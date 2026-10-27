import type {
  WorkItem,
  WorkItemDetails,
  WorkItemState,
  WorkItemStateCategory,
} from "@t3tools/contracts";
import { TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

/**
 * The work item a branch is named after: the first 4-7 digit run that stands alone between
 * separators, as in `feature/#123456-x` or `bugfix/ESP-123456`. Runs joined to other digits
 * (`2026-10-05`) or longer (`20240101`) are dates.
 */
export function workItemIdFromBranch(branch: string): number | null {
  const match = /(?:^|[/#_-])(?<!\d[_-])(\d{4,7})(?=$|[/_-])(?![_-]\d)/u.exec(branch);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/** Git config key holding a work item linked to a branch by hand. */
export const branchWorkItemConfigKey = (branch: string) => `branch.${branch}.work-item`;

/** A hand-made link wins over the id in the branch name. */
export function resolveBranchWorkItemId(
  branch: string,
  linked: string | null,
): { readonly id: number; readonly source: "linked" | "branch-name" } | null {
  const linkedId = linked === null ? Number.NaN : Number(linked.trim());
  if (Number.isSafeInteger(linkedId) && linkedId > 0) return { id: linkedId, source: "linked" };
  const named = workItemIdFromBranch(branch);
  return named === null ? null : { id: named, source: "branch-name" };
}

const FAMILY_FIELDS = [
  "System.Id",
  "System.Title",
  "System.WorkItemType",
  "System.State",
  "System.Parent",
  "System.AssignedTo",
  "System.TeamProject",
  "System.Description",
  "Microsoft.VSTS.Common.AcceptanceCriteria",
  "Microsoft.VSTS.TCM.ReproSteps",
  "System.IterationPath",
  "Microsoft.VSTS.Common.Priority",
  "System.Tags",
  "System.CreatedDate",
  "System.ChangedDate",
  "Microsoft.VSTS.Common.StateChangeDate",
];

/** The item and its direct children, without removed ones. `id` is a validated integer. */
export function workItemFamilyWiql(id: number): string {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`Invalid work item id ${id}`);
  return `SELECT ${FAMILY_FIELDS.map((field) => `[${field}]`).join(", ")} FROM WorkItems WHERE ([System.Id] = ${id} OR [System.Parent] = ${id}) AND [System.State] <> 'Removed'`;
}

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));
const OptionalNumber = Schema.optional(Schema.NullOr(Schema.Number));

const RawWorkItemsSchema = Schema.Array(
  Schema.Struct({
    id: Schema.Number,
    fields: Schema.Struct({
      "System.Title": OptionalString,
      "System.WorkItemType": OptionalString,
      "System.State": OptionalString,
      "System.Parent": OptionalNumber,
      "System.AssignedTo": Schema.optional(
        Schema.NullOr(Schema.Struct({ displayName: OptionalString })),
      ),
      "System.TeamProject": OptionalString,
      "System.Description": OptionalString,
      "Microsoft.VSTS.Common.AcceptanceCriteria": OptionalString,
      "Microsoft.VSTS.TCM.ReproSteps": OptionalString,
      "System.IterationPath": OptionalString,
      "Microsoft.VSTS.Common.Priority": OptionalNumber,
      "System.Tags": OptionalString,
      "System.CreatedDate": OptionalString,
      "System.ChangedDate": OptionalString,
      "Microsoft.VSTS.Common.StateChangeDate": OptionalString,
    }),
    url: OptionalString,
  }),
);
type RawWorkItemFields = (typeof RawWorkItemsSchema.Type)[number]["fields"];

const decodeRawWorkItems = decodeJsonResult(RawWorkItemsSchema);
const decodeRawStates = decodeJsonResult(
  Schema.Struct({
    value: Schema.Array(Schema.Struct({ name: TrimmedNonEmptyString, category: Schema.String })),
  }),
);
const decodeRawCreated = decodeJsonResult(Schema.Struct({ id: Schema.Int }));
const decodeRawPlacement = decodeJsonResult(
  Schema.Struct({
    fields: Schema.Struct({
      "System.TeamProject": TrimmedNonEmptyString,
      "System.AreaPath": OptionalString,
      "System.IterationPath": OptionalString,
    }),
  }),
);

const nonEmpty = (value: string | null | undefined) =>
  value !== undefined && value !== null && value.trim().length > 0 ? value : null;

const positive = (value: number | null | undefined) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;

function workItemDetails(fields: RawWorkItemFields): WorkItemDetails {
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
    createdAt: nonEmpty(fields["System.CreatedDate"]),
    updatedAt: nonEmpty(fields["System.ChangedDate"]),
    stateChangedAt: nonEmpty(fields["Microsoft.VSTS.Common.StateChangeDate"]),
  };
}

/** `…/{project}/_apis/wit/workItems/{id}` is the REST resource; the web page lives beside it. */
export function workItemWebUrl(apiUrl: string | null | undefined): string | null {
  if (!apiUrl) return null;
  const webUrl = apiUrl.replace(/\/_apis\/wit\/workItems\/(\d+)$/iu, "/_workitems/edit/$1");
  return webUrl === apiUrl ? null : webUrl;
}

export interface WorkItemFamilyMember extends WorkItem {
  /** Azure Boards project the item lives in; needed to read its type's states. */
  readonly project: string | null;
}

export interface WorkItemFamily {
  readonly items: ReadonlyArray<WorkItemFamilyMember>;
  /** Long text of the item the family was read for; children's would inflate every read. */
  readonly rootDetails: WorkItemDetails | null;
}

/** `az boards query` output for {@link workItemFamilyWiql}. */
export function decodeWorkItemFamilyJson(
  raw: string,
  rootId: number,
): Result.Result<WorkItemFamily, unknown> {
  if (raw.trim().length === 0) return Result.succeed({ items: [], rootDetails: null });
  const decoded = decodeRawWorkItems(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  let rootDetails: WorkItemDetails | null = null;
  const items: WorkItemFamilyMember[] = [];
  for (const item of decoded.success) {
    const id = positive(item.id);
    if (id === null) continue;
    if (id === rootId) rootDetails = workItemDetails(item.fields);
    items.push({
      id,
      title: item.fields["System.Title"] ?? "",
      type: nonEmpty(item.fields["System.WorkItemType"]),
      state: nonEmpty(item.fields["System.State"]),
      parentId: positive(item.fields["System.Parent"]),
      assignedTo: nonEmpty(item.fields["System.AssignedTo"]?.displayName),
      project: nonEmpty(item.fields["System.TeamProject"]),
      url: workItemWebUrl(item.url),
    });
  }
  return Result.succeed({ items, rootDetails });
}

const STATE_CATEGORIES: Readonly<Record<string, WorkItemStateCategory>> = {
  Proposed: "proposed",
  InProgress: "in-progress",
  Resolved: "resolved",
  Completed: "completed",
  Removed: "removed",
};

/** A type's states from `workItemTypeStates`, without removed ones. */
export function decodeWorkItemStatesJson(
  raw: string,
): Result.Result<ReadonlyArray<WorkItemState>, unknown> {
  const decoded = decodeRawStates(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  return Result.succeed(
    decoded.success.value.flatMap((state) => {
      const category = STATE_CATEGORIES[state.category];
      return category === undefined || category === "removed"
        ? []
        : [{ name: state.name, category }];
    }),
  );
}

export const decodeCreatedWorkItemJson = decodeRawCreated;

/** Where a parent lives, so its new child lands in the same project, area and iteration. */
export function decodeWorkItemPlacementJson(raw: string) {
  const decoded = decodeRawPlacement(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const fields = decoded.success.fields;
  return Result.succeed({
    project: fields["System.TeamProject"],
    area: nonEmpty(fields["System.AreaPath"]),
    iteration: nonEmpty(fields["System.IterationPath"]),
  });
}
