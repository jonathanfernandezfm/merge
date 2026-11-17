import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt } from "../baseSchemas.ts";
import { WorkTaskId } from "./workTasks.ts";

/** The ADO work item a task is for, from its links or else its branch name. */
export const WorkTaskWorkItem = Schema.Struct({
  id: PositiveInt,
  title: Schema.String,
  type: Schema.String,
  state: Schema.String,
  sprint: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  source: Schema.Literals(["linked", "branch-name"]),
});
export type WorkTaskWorkItem = typeof WorkTaskWorkItem.Type;

/** Review facts the thread PR snapshot lacks, cached per open PR. */
export const WorkTaskPullRequestFacts = Schema.Struct({
  number: PositiveInt,
  review: Schema.Literals(["approved", "changes-requested", "pending", "none"]),
  checks: Schema.Literals(["passing", "failing", "pending", "none"]),
  mergeConflicts: Schema.Boolean,
  unresolvedComments: NonNegativeInt,
  syncedAt: IsoDateTime,
});
export type WorkTaskPullRequestFacts = typeof WorkTaskPullRequestFacts.Type;

export const WorkTaskInsight = Schema.Struct({
  taskId: WorkTaskId,
  workItem: Schema.NullOr(WorkTaskWorkItem),
  pullRequest: Schema.NullOr(WorkTaskPullRequestFacts),
});
export type WorkTaskInsight = typeof WorkTaskInsight.Type;

export const WorkTaskInsightsSnapshot = Schema.Struct({
  insights: Schema.Array(WorkTaskInsight),
});
export type WorkTaskInsightsSnapshot = typeof WorkTaskInsightsSnapshot.Type;
