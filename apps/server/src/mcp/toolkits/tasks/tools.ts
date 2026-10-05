import {
  McpCapabilityUnavailableError,
  TaskId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as TaskWorkspaceService from "../../../task/TaskWorkspaceService.ts";

export const CreateTaskInput = Schema.Struct({
  projectPath: TrimmedNonEmptyString.annotate({
    description:
      "Root directory of the Merge project the work belongs to, for example /Users/me/code/backend. Must be a project already added to Merge.",
  }),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)).annotate({
    description: "Short task title, for example the work item id and summary.",
  }),
  branch: TrimmedNonEmptyString.annotate({
    description:
      "The branch the work lives on. It must already exist locally or on the remote; this tool never creates branches.",
  }),
  description: Schema.optional(
    Schema.String.check(Schema.isMaxLength(20_000)).annotate({
      description: "What the task is about and how it relates to this thread.",
    }),
  ),
  worktreePath: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "A worktree you already created for branch. The task takes it over, uncommitted changes included. Omit to let Merge create the worktree.",
    }),
  ),
});
export type CreateTaskInput = typeof CreateTaskInput.Type;

export const CreateTaskResult = Schema.Struct({
  taskId: TaskId,
  threadId: ThreadId,
});
export type CreateTaskResult = typeof CreateTaskResult.Type;

export class TaskProjectNotFoundError extends Schema.TaggedError<TaskProjectNotFoundError>()(
  "TaskProjectNotFoundError",
  { projectPath: Schema.String, knownProjects: Schema.Array(Schema.String) },
) {
  override get message(): string {
    const known = this.knownProjects.length > 0 ? this.knownProjects.join(", ") : "none";
    return `${this.projectPath} is not a Merge project. Known project roots: ${known}. Ask the user to add it, then retry.`;
  }
}

export class TaskCreateFailedError extends Schema.TaggedError<TaskCreateFailedError>()(
  "TaskCreateFailedError",
  { reason: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export const TaskToolError = Schema.Union([
  McpCapabilityUnavailableError,
  TaskProjectNotFoundError,
  TaskCreateFailedError,
]);
export type TaskToolError = typeof TaskToolError.Type;

const CreateTaskTool = Tool.make("create_task", {
  description:
    "Create a Merge task for work on another project, for example when a fix turns out to belong in a different repository than this thread's. Create and push (or at least create) the branch first, ideally in its own worktree, then call this so Merge tracks the work on its taskboard. The task opens a new thread in that worktree.",
  parameters: CreateTaskInput,
  success: CreateTaskResult,
  failure: TaskToolError,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ProjectionSnapshotQuery.ProjectionSnapshotQuery,
    TaskWorkspaceService.TaskWorkspaceService,
  ],
})
  .annotate(Tool.Title, "Create task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const TasksToolkit = Toolkit.make(CreateTaskTool);
