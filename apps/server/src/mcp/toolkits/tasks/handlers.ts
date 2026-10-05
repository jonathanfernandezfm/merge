import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as TaskWorkspaceService from "../../../task/TaskWorkspaceService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { TaskCreateFailedError, TaskProjectNotFoundError, TasksToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const tasks = yield* TaskWorkspaceService.TaskWorkspaceService;
  const path = yield* Path.Path;

  const readFailed = (cause: { readonly message: string }) =>
    new TaskCreateFailedError({ reason: "failed", detail: cause.message });

  return TasksToolkit.of({
    create_task: (input) =>
      Effect.gen(function* () {
        yield* McpInvocationContext.requireMcpCapability("tasks");
        // Agents pass paths with trailing slashes or relative segments; project roots are stored resolved.
        const projectPath = path.resolve(input.projectPath);
        const project = yield* snapshots
          .getActiveProjectByWorkspaceRoot(projectPath)
          .pipe(Effect.mapError(readFailed));
        if (Option.isNone(project)) {
          const shells = yield* snapshots.getProjectShells().pipe(Effect.mapError(readFailed));
          return yield* new TaskProjectNotFoundError({
            projectPath,
            knownProjects: shells.map((shell) => shell.workspaceRoot),
          });
        }
        return yield* tasks
          .create({
            projectId: project.value.id,
            title: input.title,
            branch: input.branch,
            ...(input.description === undefined ? {} : { description: input.description }),
            ...(input.worktreePath === undefined
              ? {}
              : { worktreePath: path.resolve(input.worktreePath) }),
          })
          .pipe(
            Effect.mapError(
              (error) => new TaskCreateFailedError({ reason: error.reason, detail: error.message }),
            ),
          );
      }),
  });
});

export const TasksToolkitHandlersLive = TasksToolkit.toLayer(make);
