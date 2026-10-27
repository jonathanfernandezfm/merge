import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "../auth.ts";
import { PositiveInt, TrimmedNonEmptyString } from "../baseSchemas.ts";
import { SourceControlRepositoryError } from "../sourceControl.ts";

/** Azure Boards state categories; they drive how a state is drawn regardless of its name. */
export const WorkItemStateCategory = Schema.Literals([
  "proposed",
  "in-progress",
  "resolved",
  "completed",
  "removed",
]);
export type WorkItemStateCategory = typeof WorkItemStateCategory.Type;

export const WorkItemState = Schema.Struct({
  name: TrimmedNonEmptyString,
  category: WorkItemStateCategory,
});
export type WorkItemState = typeof WorkItemState.Type;

export const WorkItem = Schema.Struct({
  id: PositiveInt,
  title: Schema.String,
  type: Schema.NullOr(Schema.String),
  state: Schema.NullOr(Schema.String),
  parentId: Schema.NullOr(PositiveInt),
  assignedTo: Schema.NullOr(Schema.String),
  /** The work item in Azure Boards' web UI. */
  url: Schema.NullOr(Schema.String),
});
export type WorkItem = typeof WorkItem.Type;

/** The long-form fields of the branch's own work item; HTML as Azure Boards stores it. */
export const WorkItemDetails = Schema.Struct({
  descriptionHtml: Schema.NullOr(Schema.String),
  /** Acceptance criteria, or repro steps for bugs. */
  criteriaHtml: Schema.NullOr(Schema.String),
  criteriaLabel: Schema.Literals(["Acceptance criteria", "Repro steps"]),
  sprint: Schema.NullOr(Schema.String),
  priority: Schema.NullOr(Schema.Number),
  tags: Schema.Array(Schema.String),
  createdAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Schema.String),
  stateChangedAt: Schema.NullOr(Schema.String),
});
export type WorkItemDetails = typeof WorkItemDetails.Type;

export const BranchWorkItemsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type BranchWorkItemsInput = typeof BranchWorkItemsInput.Type;

/**
 * The work item the checked-out branch is tied to, with its direct children.
 * `source` says whether the id was linked by hand or read from the branch name.
 */
export const BranchWorkItems = Schema.Struct({
  branch: Schema.NullOr(TrimmedNonEmptyString),
  /** Only Azure DevOps repositories have work items. */
  supported: Schema.Boolean,
  source: Schema.NullOr(Schema.Literals(["linked", "branch-name"])),
  /** The resolved id; set even when Azure Boards has no item by that id. */
  workItemId: Schema.NullOr(PositiveInt),
  root: Schema.NullOr(WorkItem),
  rootDetails: Schema.NullOr(WorkItemDetails),
  children: Schema.Array(WorkItem),
  /** Allowed states per work item type present in the family. */
  states: Schema.Record(Schema.String, Schema.Array(WorkItemState)),
});
export type BranchWorkItems = typeof BranchWorkItems.Type;

export const LinkBranchWorkItemInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  /** Null removes the link, falling back to the id in the branch name. */
  id: Schema.NullOr(PositiveInt),
});
export type LinkBranchWorkItemInput = typeof LinkBranchWorkItemInput.Type;

export const UpdateWorkItemInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  id: PositiveInt,
  state: Schema.optionalKey(TrimmedNonEmptyString),
  assignToMe: Schema.optionalKey(Schema.Boolean),
});
export type UpdateWorkItemInput = typeof UpdateWorkItemInput.Type;

export const CreateChildWorkItemInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  parentId: PositiveInt,
  type: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
});
export type CreateChildWorkItemInput = typeof CreateChildWorkItemInput.Type;

export const CreateChildWorkItemResult = Schema.Struct({ id: PositiveInt });
export type CreateChildWorkItemResult = typeof CreateChildWorkItemResult.Type;

export const WorkItemsError = Schema.Union([
  SourceControlRepositoryError,
  EnvironmentAuthorizationError,
]);
