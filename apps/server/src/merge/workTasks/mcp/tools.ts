import {
  OrchestratorMcpFailure,
  ThreadId,
  TrimmedNonEmptyString,
  WorkTaskId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";

const CreateWorkTaskTool = Tool.make("create_work_task", {
  description:
    "Track work on an existing branch of another project as a Merge Work Task, e.g. when the fix belongs in a different repo. Push or create the branch first; this never creates branches. Opens a thread in the task's worktree.",
  parameters: Schema.Struct({
    projectPath: TrimmedNonEmptyString.annotate({
      description: "Root directory of a project already added to Merge.",
    }),
    title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
    branch: TrimmedNonEmptyString.annotate({ description: "Existing local or remote branch." }),
    description: Schema.optional(Schema.String.check(Schema.isMaxLength(20_000))),
    worktreePath: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description: "Your worktree on `branch`; the task takes it over with its changes.",
      }),
    ),
  }),
  success: Schema.Struct({ workTaskId: WorkTaskId, threadId: ThreadId }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    Crypto.Crypto,
  ],
})
  .annotate(Tool.Title, "Create Work Task")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

/** Fork MCP tools, registered at the `mcp-tools` seam. */
export const MergeToolkit = Toolkit.make(CreateWorkTaskTool);
