import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkTaskId,
  WorkTaskOperationError,
  type Project,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../../mcp/McpToolAccess.testkit.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as WorkTaskWorkspace from "../WorkTaskWorkspace.ts";
import { MergeToolkitHandlers } from "./handlers.ts";
import { MergeToolkit } from "./tools.ts";

const ROOT = "/workspace/backend";
const PROJECT_ID = ProjectId.make("project-backend");
const CALLER = ThreadId.make("thread-caller");

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  thread: {
    threadId: CALLER,
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const makeHarness = (createError: WorkTaskOperationError | null = null) =>
  Effect.gen(function* () {
    const created: Array<{ readonly input: unknown; readonly launcher: unknown }> = [];
    const dependencies = Layer.mergeAll(
      Layer.mock(ProjectService.ProjectService)({
        getByWorkspaceRoot: (root) =>
          Effect.succeed(
            root === ROOT ? Option.some({ id: PROJECT_ID } as Project) : Option.none(),
          ),
        listShells: () => Effect.succeed([{ workspaceRoot: ROOT } as never]),
      }),
      Layer.mock(WorkTaskWorkspace.WorkTaskWorkspace)({
        create: (input, launcher) =>
          createError !== null
            ? Effect.fail(createError)
            : Effect.sync(() => {
                created.push({ input, launcher });
                return {
                  taskId: WorkTaskId.make("task-1"),
                  threadId: ThreadId.make("thread-task"),
                };
              }),
      }),
      McpToolAccessTestkit.liveThreadsLayer,
      NodeServices.layer,
    );
    const toolkit = yield* MergeToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(MergeToolkitHandlers).pipe(Layer.provide(dependencies)),
      ),
    );
    const call = (
      params: Parameters<typeof toolkit.handle<"create_work_task">>[1],
      capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["orchestration"],
    ) =>
      toolkit.handle("create_work_task", params).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map(
          (chunk) =>
            chunk.at(-1)!.result as
              | Tool.Success<(typeof MergeToolkit.tools)["create_work_task"]>
              | Tool.Failure<(typeof MergeToolkit.tools)["create_work_task"]>,
        ),
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
        Effect.provide(dependencies),
      );
    return { created, call };
  });

describe("create_work_task", () => {
  it.effect("resolves the project by its root and returns workTaskId", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call({
        projectPath: `${ROOT}/`,
        title: "#604676 avatar initials",
        branch: "bugfix/604676",
        worktreePath: "/workspace/backend-worktrees/bugfix-604676/",
      });
      expect(result).toEqual({ workTaskId: "task-1", threadId: "thread-task" });
      expect(harness.created).toEqual([
        {
          input: {
            projectId: PROJECT_ID,
            title: "#604676 avatar initials",
            branch: "bugfix/604676",
            worktreePath: "/workspace/backend-worktrees/bugfix-604676",
          },
          // The calling thread's modes are the ceiling for the thread it starts.
          launcher: {
            createdBy: "agent",
            creationSource: "mcp",
            runtimeMode: "full-access",
            interactionMode: "default",
          },
        },
      ]);
    }),
  );

  it.effect("lists known projects when the path is not one", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness.call({
        projectPath: "/workspace/unknown",
        title: "Fix",
        branch: "fix",
      });
      expect(error).toMatchObject({ _tag: "OrchestratorMcpFailure", code: "invalid_request" });
      expect("message" in error ? error.message : "").toContain(ROOT);
      expect(harness.created).toEqual([]);
    }),
  );

  it.effect("reports why the Work Task was refused", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        new WorkTaskOperationError({ reason: "remote-branch-missing", message: "No such branch." }),
      );
      const error = yield* harness.call({ projectPath: ROOT, title: "Fix", branch: "fix" });
      expect(error).toMatchObject({ code: "invalid_request", message: "No such branch." });
    }),
  );

  it.effect("refuses a credential without the orchestration capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness.call({ projectPath: ROOT, title: "Fix", branch: "fix" }, [
        "pull-requests",
      ]);
      expect(error).toMatchObject({ code: "capability_denied" });
      expect(harness.created).toEqual([]);
    }),
  );
});
