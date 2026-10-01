import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  TaskId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationTaskWorkspace,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");
const TASK_ID = TaskId.make("task-1");

const workspace: OrchestrationTaskWorkspace = {
  path: null,
  branch: "feature/widgets",
  remoteName: "origin",
  remoteBranch: "feature/widgets",
  baseBranch: "main",
  setup: { status: "pending", steps: [], error: null, updatedAt: NOW },
};

// Decide a command and fold its events into the read model, like the engine.
const dispatch = Effect.fn("dispatch")(function* (
  readModel: OrchestrationReadModel,
  command: OrchestrationCommand,
) {
  const decided = yield* decideOrchestrationCommand({ command, readModel });
  const events = Array.isArray(decided) ? decided : [decided];
  let next = readModel;
  for (const event of events) {
    next = yield* projectEvent(next, { ...event, sequence: next.snapshotSequence + 1 });
  }
  return { readModel: next, events };
});

const createProject = (readModel: OrchestrationReadModel) =>
  dispatch(readModel, {
    type: "project.create",
    commandId: CommandId.make("cmd-project"),
    projectId: PROJECT_ID,
    title: "Project",
    workspaceRoot: "/repo",
    createdAt: NOW,
  });

const createTask = (readModel: OrchestrationReadModel) =>
  dispatch(readModel, {
    type: "task.create",
    commandId: CommandId.make("cmd-task"),
    taskId: TASK_ID,
    projectId: PROJECT_ID,
    title: "Widgets",
    description: null,
    workspace,
    autoHandleReviewFeedback: true,
    autoHandleCIFailures: false,
    createdAt: NOW,
  });

const threadCreate = (taskId: TaskId): OrchestrationCommand => ({
  type: "thread.create",
  commandId: CommandId.make("cmd-thread"),
  threadId: ThreadId.make("thread-1"),
  projectId: PROJECT_ID,
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: workspace.branch,
  worktreePath: "/repo/.worktrees/widgets",
  taskId,
  origin: "review-feedback",
  createdAt: NOW,
});

const withTask = Effect.gen(function* () {
  const project = yield* createProject(createEmptyReadModel(NOW));
  return (yield* createTask(project.readModel)).readModel;
});

it.layer(NodeServices.layer)("task decider", (it) => {
  it.effect("task.create emits task.created and projects a fresh task", () =>
    Effect.gen(function* () {
      const project = yield* createProject(createEmptyReadModel(NOW));
      const { readModel, events } = yield* createTask(project.readModel);

      expect(events.map((event) => [event.type, event.aggregateKind, event.aggregateId])).toEqual([
        ["task.created", "task", TASK_ID],
      ]);
      expect(readModel.tasks).toEqual([
        {
          id: TASK_ID,
          projectId: PROJECT_ID,
          title: "Widgets",
          description: null,
          workspace,
          pullRequest: null,
          autoHandleReviewFeedback: true,
          autoHandleCIFailures: false,
          waitingForUserReason: null,
          createdAt: NOW,
          updatedAt: NOW,
          mergedAt: null,
          archivedAt: null,
          deletedAt: null,
        },
      ]);
    }),
  );

  it.effect("task.create rejects an unknown project and a duplicate task", () =>
    Effect.gen(function* () {
      const missingProject = yield* Effect.exit(createTask(createEmptyReadModel(NOW)));
      expect(Exit.isFailure(missingProject)).toBe(true);

      const duplicate = yield* Effect.exit(createTask(yield* withTask));
      expect(Exit.isFailure(duplicate)).toBe(true);
    }),
  );

  it.effect("task.meta.update and task.sync patch only the fields they carry", () =>
    Effect.gen(function* () {
      const renamed = yield* dispatch(yield* withTask, {
        type: "task.meta.update",
        commandId: CommandId.make("cmd-meta"),
        taskId: TASK_ID,
        title: "Better widgets",
        autoHandleReviewFeedback: false,
      });
      expect(renamed.events.map((event) => event.type)).toEqual(["task.meta-updated"]);

      const synced = yield* dispatch(renamed.readModel, {
        type: "task.sync",
        commandId: CommandId.make("cmd-sync"),
        taskId: TASK_ID,
        workspace: { ...workspace, path: "/repo/.worktrees/widgets" },
        mergedAt: NOW,
      });
      const task = synced.readModel.tasks?.[0];
      expect(task?.title).toBe("Better widgets");
      expect(task?.autoHandleReviewFeedback).toBe(false);
      expect(task?.autoHandleCIFailures).toBe(false);
      expect(task?.workspace.path).toBe("/repo/.worktrees/widgets");
      expect(task?.mergedAt).toBe(NOW);
      expect(task?.pullRequest).toBeNull();
    }),
  );

  it.effect("task.archive archives once and then blocks further task commands", () =>
    Effect.gen(function* () {
      const archived = yield* dispatch(yield* withTask, {
        type: "task.archive",
        commandId: CommandId.make("cmd-archive"),
        taskId: TASK_ID,
      });
      expect(archived.events.map((event) => event.type)).toEqual(["task.archived"]);
      expect(archived.readModel.tasks?.[0]?.archivedAt).not.toBeNull();

      const again = yield* Effect.exit(
        dispatch(archived.readModel, {
          type: "task.archive",
          commandId: CommandId.make("cmd-archive-2"),
          taskId: TASK_ID,
        }),
      );
      expect(Exit.isFailure(again)).toBe(true);

      const update = yield* Effect.exit(
        dispatch(archived.readModel, {
          type: "task.meta.update",
          commandId: CommandId.make("cmd-meta-archived"),
          taskId: TASK_ID,
          title: "Too late",
        }),
      );
      expect(Exit.isFailure(update)).toBe(true);
    }),
  );

  it.effect("thread.create inside a task keeps taskId and origin", () =>
    Effect.gen(function* () {
      const { readModel, events } = yield* dispatch(yield* withTask, threadCreate(TASK_ID));
      const [created] = events;
      expect(created?.type).toBe("thread.created");
      if (created?.type === "thread.created") {
        expect(created.payload.taskId).toBe(TASK_ID);
        expect(created.payload.origin).toBe("review-feedback");
      }
      expect(readModel.threads[0]?.taskId).toBe(TASK_ID);
      expect(readModel.threads[0]?.origin).toBe("review-feedback");
    }),
  );

  it.effect("thread.create rejects an unknown or archived task", () =>
    Effect.gen(function* () {
      const unknown = yield* Effect.exit(
        dispatch(yield* withTask, threadCreate(TaskId.make("task-missing"))),
      );
      expect(Exit.isFailure(unknown)).toBe(true);

      const archived = yield* dispatch(yield* withTask, {
        type: "task.archive",
        commandId: CommandId.make("cmd-archive"),
        taskId: TASK_ID,
      });
      const inArchived = yield* Effect.exit(dispatch(archived.readModel, threadCreate(TASK_ID)));
      expect(Exit.isFailure(inArchived)).toBe(true);
    }),
  );
  it.effect("threads of an archived task cannot be unarchived or start a turn", () =>
    Effect.gen(function* () {
      const withThread = yield* dispatch(yield* withTask, threadCreate(TASK_ID));
      const threadArchived = yield* dispatch(withThread.readModel, {
        type: "thread.archive",
        commandId: CommandId.make("cmd-thread-archive"),
        threadId: ThreadId.make("thread-1"),
      });
      const unarchive: OrchestrationCommand = {
        type: "thread.unarchive",
        commandId: CommandId.make("cmd-thread-unarchive"),
        threadId: ThreadId.make("thread-1"),
      };
      const turnStart: OrchestrationCommand = {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: MessageId.make("message-1"),
          role: "user",
          text: "Keep going",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: NOW,
      };

      // While the task is active both are allowed.
      const revived = yield* Effect.exit(dispatch(threadArchived.readModel, unarchive));
      expect(Exit.isSuccess(revived)).toBe(true);
      const started = yield* Effect.exit(dispatch(withThread.readModel, turnStart));
      expect(Exit.isSuccess(started)).toBe(true);

      const taskArchived = yield* dispatch(threadArchived.readModel, {
        type: "task.archive",
        commandId: CommandId.make("cmd-archive"),
        taskId: TASK_ID,
      });
      const blockedUnarchive = yield* Effect.exit(dispatch(taskArchived.readModel, unarchive));
      expect(Exit.isFailure(blockedUnarchive)).toBe(true);
      const blockedTurn = yield* Effect.exit(dispatch(taskArchived.readModel, turnStart));
      expect(Exit.isFailure(blockedTurn)).toBe(true);
    }),
  );
});
