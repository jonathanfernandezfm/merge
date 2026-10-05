import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  TaskId,
  TaskOperationError,
  ThreadId,
  type OrchestrationProject,
  type OrchestrationProjectShell,
  type TaskCreateInput,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { TaskWorkspaceService } from "../../../task/TaskWorkspaceService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { TasksToolkitHandlersLive } from "./handlers.ts";
import { TasksToolkit } from "./tools.ts";

const PROJECT_ROOT = "/workspace/backend";
const PROJECT_ID = ProjectId.make("project-backend");

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-frontend"),
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("claude"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const makeHarness = Effect.fn("makeTasksToolkitHarness")(function* (
  createError: TaskOperationError | null = null,
) {
  const created = yield* Ref.make<ReadonlyArray<TaskCreateInput>>([]);
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getActiveProjectByWorkspaceRoot: (root) =>
        Effect.succeed(
          root === PROJECT_ROOT
            ? Option.some({ id: PROJECT_ID } as OrchestrationProject)
            : Option.none(),
        ),
      getProjectShells: () =>
        Effect.succeed([{ workspaceRoot: PROJECT_ROOT } as OrchestrationProjectShell]),
    }),
    Layer.mock(TaskWorkspaceService)({
      create: (input) =>
        createError !== null
          ? Effect.fail(createError)
          : Ref.update(created, (all) => [...all, input]).pipe(
              Effect.as({ taskId: TaskId.make("task-1"), threadId: ThreadId.make("thread-task") }),
            ),
    }),
    NodeServices.layer,
  );
  const toolkit = yield* TasksToolkit.pipe(
    Effect.provide(TasksToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = (
    params: Parameters<typeof toolkit.handle<"create_task">>[1],
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["tasks"],
  ) =>
    toolkit.handle("create_task", params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof TasksToolkit.tools)["create_task"]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
      Effect.provide(dependencies),
    );
  return { created, call };
});

describe("tasks toolkit handlers", () => {
  it.effect("creates a task in the project found by its root path", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call({
        projectPath: `${PROJECT_ROOT}/`,
        title: "#604676 comment avatar initials",
        branch: "bugfix/604676",
        worktreePath: "/workspace/backend-worktrees/bugfix-604676/",
      });
      expect(result).toEqual({ taskId: "task-1", threadId: "thread-task" });
      expect(yield* Ref.get(harness.created)).toEqual([
        {
          projectId: PROJECT_ID,
          title: "#604676 comment avatar initials",
          branch: "bugfix/604676",
          worktreePath: "/workspace/backend-worktrees/bugfix-604676",
        },
      ]);
    }),
  );

  it.effect("lists known projects when the path is not one", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call({ projectPath: "/workspace/unknown", title: "Fix", branch: "fix" })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "TaskProjectNotFoundError",
        knownProjects: [PROJECT_ROOT],
      });
      expect(yield* Ref.get(harness.created)).toEqual([]);
    }),
  );

  it.effect("reports why the task service refused", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        new TaskOperationError({ reason: "remote-branch-missing", message: "No such branch." }),
      );
      const error = yield* harness
        .call({ projectPath: PROJECT_ROOT, title: "Fix", branch: "fix" })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "TaskCreateFailedError",
        reason: "remote-branch-missing",
        detail: "No such branch.",
      });
    }),
  );

  it.effect("refuses a credential without the tasks capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call({ projectPath: PROJECT_ROOT, title: "Fix", branch: "fix" }, ["pull-requests"])
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "McpCapabilityUnavailableError", capability: "tasks" });
      expect(yield* Ref.get(harness.created)).toEqual([]);
    }),
  );
});
