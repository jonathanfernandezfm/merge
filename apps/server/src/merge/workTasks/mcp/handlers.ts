import { OrchestratorMcpFailure, type WorkTaskOperationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { readCaller, unavailable } from "../../../mcp/threadAccess.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import { lookup } from "../../workspaceGuard.ts";
import { WorkTaskWorkspace } from "../WorkTaskWorkspace.ts";
import { MergeToolkit } from "./tools.ts";

const operationFailure = (error: WorkTaskOperationError) =>
  new OrchestratorMcpFailure({
    code: error.reason === "failed" ? "orchestration_error" : "invalid_request",
    message: error.message,
  });

/**
 * WorkTaskWorkspace and Path are looked up per call, so registering the toolkit adds no
 * requirements to upstream's MCP harnesses.
 */
export const MergeToolkitHandlers = McpToolAccess.toLayer(MergeToolkit, {
  create_work_task: McpToolAccess.startsThreads(
    () => ({}),
    (input, modes) =>
      Effect.gen(function* () {
        // Thread control needs the orchestration capability, as t3_thread_launch does.
        yield* readCaller();
        const path = yield* lookup(Path.Path);
        const projects = yield* ProjectService.ProjectService;
        // Agents pass trailing slashes or relative segments; project roots are stored resolved.
        const projectPath = path.resolve(input.projectPath);
        const project = yield* projects
          .getByWorkspaceRoot(projectPath)
          .pipe(Effect.mapError(unavailable));
        if (Option.isNone(project)) {
          const known = (yield* projects.listShells().pipe(Effect.mapError(unavailable))).map(
            (shell) => shell.workspaceRoot,
          );
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: `${projectPath} is not a Merge project. Known project roots: ${known.join(", ") || "none"}. Ask the user to add it, then retry.`,
          });
        }
        const workspace = yield* lookup(WorkTaskWorkspace);
        const created = yield* workspace
          .create(
            {
              projectId: project.value.id,
              title: input.title,
              branch: input.branch,
              ...(input.description === undefined ? {} : { description: input.description }),
              ...(input.worktreePath === undefined
                ? {}
                : { worktreePath: path.resolve(input.worktreePath) }),
            },
            { createdBy: "agent", creationSource: "mcp", ...modes },
          )
          .pipe(Effect.mapError(operationFailure));
        return { workTaskId: created.taskId, threadId: created.threadId };
      }),
  ),
});
