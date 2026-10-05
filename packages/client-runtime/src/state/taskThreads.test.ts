import { TaskId, ThreadId, TurnId, type OrchestrationTaskShell } from "@t3tools/contracts";
import { TASK_STATUSES } from "@t3tools/shared/taskStatus";
import { describe, expect, it } from "vite-plus/test";

import {
  groupTaskboardTasks,
  latestTaskThread,
  resolveTaskStatus,
  taskboardColumnForStatus,
  taskThreadsInOrder,
  taskThreadState,
  taskThreadTabState,
  type TaskThreadShell,
} from "./taskThreads.ts";

const TASK_ID = TaskId.make("task-1");

function thread(overrides: Partial<TaskThreadShell> = {}): TaskThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    taskId: TASK_ID,
    origin: "user",
    title: "Implementation",
    session: null,
    latestTurn: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    settledOverride: null,
    archivedAt: null,
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
    latestUserMessageAt: null,
    ...overrides,
  };
}

const RUNNING_SESSION = {
  threadId: ThreadId.make("thread-1"),
  status: "running",
  providerName: "codex",
  runtimeMode: "full-access",
  activeTurnId: null,
  lastError: null,
  updatedAt: "2026-10-01T10:00:00.000Z",
} as const satisfies NonNullable<TaskThreadShell["session"]>;

const COMPLETED_TURN = {
  turnId: TurnId.make("turn-1"),
  state: "completed",
  requestedAt: "2026-10-01T10:00:00.000Z",
  startedAt: "2026-10-01T10:00:00.000Z",
  completedAt: "2026-10-01T10:01:00.000Z",
  assistantMessageId: null,
} as const satisfies NonNullable<TaskThreadShell["latestTurn"]>;

describe("taskThreadState", () => {
  it("treats a pending approval as waiting even while a turn runs", () => {
    expect(taskThreadState(thread({ session: RUNNING_SESSION, hasPendingApprovals: true }))).toBe(
      "waiting",
    );
  });

  it("distinguishes a thread that never ran from one that finished a turn", () => {
    expect(taskThreadState(thread())).toBe("new");
    expect(taskThreadState(thread({ latestTurn: COMPLETED_TURN }))).toBe("idle");
    expect(taskThreadState(thread({ session: RUNNING_SESSION }))).toBe("running");
  });

  it("keeps a thread running while its subagents work after the turn settles", () => {
    const settled = {
      session: { ...RUNNING_SESSION, status: "ready" as const },
      latestTurn: COMPLETED_TURN,
    };
    expect(taskThreadState(thread({ ...settled, backgroundLiveness: "working" }))).toBe("running");
    expect(taskThreadState(thread({ ...settled, backgroundLiveness: "monitoring" }))).toBe("idle");
    expect(
      taskThreadState(
        thread({
          session: { ...RUNNING_SESSION, status: "error" as const },
          latestTurn: COMPLETED_TURN,
          backgroundLiveness: "working",
        }),
      ),
    ).toBe("idle");
  });
});

describe("resolveTaskStatus", () => {
  const TASK = task({ id: TASK_ID });

  it("reads working while a settled thread's subagents still run", () => {
    expect(
      resolveTaskStatus(TASK, [
        thread({ latestTurn: COMPLETED_TURN, backgroundLiveness: "working" }),
      ]),
    ).toBe("working");
    expect(resolveTaskStatus(TASK, [thread({ latestTurn: COMPLETED_TURN })])).toBe("idle");
  });

  it("reads idle for a task with no threads or only a fresh one", () => {
    expect(resolveTaskStatus(TASK, [])).toBe("idle");
    expect(resolveTaskStatus(TASK, [thread()])).toBe("idle");
  });
});

describe("taskThreadTabState", () => {
  it("shows settled idle threads as completed", () => {
    expect(
      taskThreadTabState(thread({ latestTurn: COMPLETED_TURN, settledOverride: "settled" })),
    ).toBe("completed");
    expect(taskThreadTabState(thread({ latestTurn: COMPLETED_TURN }))).toBe("idle");
  });
});

describe("taskThreadsInOrder", () => {
  it("keeps the task's live threads in creation order", () => {
    const first = thread({ id: ThreadId.make("a"), createdAt: "2026-10-01T09:00:00.000Z" });
    const second = thread({ id: ThreadId.make("b"), createdAt: "2026-10-01T11:00:00.000Z" });
    const archived = thread({ id: ThreadId.make("c"), archivedAt: "2026-10-01T12:00:00.000Z" });
    const elsewhere = thread({ id: ThreadId.make("d"), taskId: TaskId.make("task-2") });
    expect(
      taskThreadsInOrder([second, archived, elsewhere, first], TASK_ID).map((entry) => entry.id),
    ).toEqual(["a", "b"]);
  });
});

describe("latestTaskThread", () => {
  it("lands on the most recently active live thread", () => {
    const older = thread({ id: ThreadId.make("a"), latestUserMessageAt: "2026-10-01T10:00:00Z" });
    const newer = thread({ id: ThreadId.make("b"), latestUserMessageAt: "2026-10-01T11:00:00Z" });
    const archived = thread({
      id: ThreadId.make("c"),
      latestUserMessageAt: "2026-10-01T12:00:00Z",
      archivedAt: "2026-10-01T12:30:00Z",
    });
    expect(latestTaskThread([older, newer, archived])?.id).toBe("b");
    expect(latestTaskThread([])).toBeNull();
  });
});

describe("taskboardColumnForStatus", () => {
  it("maps every status to its column", () => {
    const columns = Object.fromEntries(
      TASK_STATUSES.map((status) => [status, taskboardColumnForStatus(status)]),
    );
    expect(columns).toEqual({
      "setting-up": "working",
      "setup-failed": "needs-you",
      working: "working",
      "waiting-for-user": "needs-you",
      idle: "working",
      "ci-running": "in-review",
      "ci-failing": "needs-you",
      "changes-requested": "needs-you",
      "addressing-comments": "working",
      "waiting-for-review": "in-review",
      approved: "ready-to-merge",
      "merge-ready": "ready-to-merge",
      merged: "archive",
      archived: "archive",
    });
  });
});

function task(overrides: Partial<OrchestrationTaskShell> & Pick<OrchestrationTaskShell, "id">) {
  return {
    title: "Task",
    pullRequest: null,
    waitingForUserReason: null,
    mergedAt: null,
    archivedAt: null,
    updatedAt: "2026-10-01T09:00:00.000Z",
    workspace: { setup: { status: "done" } },
    ...overrides,
  } as OrchestrationTaskShell;
}

describe("groupTaskboardTasks", () => {
  it("puts one card per task in its column, most recently active first", () => {
    const quiet = task({ id: TaskId.make("quiet"), updatedAt: "2026-10-01T10:00:00.000Z" });
    const busy = task({ id: TaskId.make("busy"), updatedAt: "2026-10-01T08:00:00.000Z" });
    const blocked = task({ id: TaskId.make("blocked"), waitingForUserReason: "Pick a library" });
    const archived = task({ id: TaskId.make("old"), archivedAt: "2026-10-01T12:00:00.000Z" });
    const busyThreads = [
      thread({
        id: ThreadId.make("t1"),
        taskId: busy.id,
        latestUserMessageAt: "2026-10-01T09:00:00.000Z",
      }),
      thread({
        id: ThreadId.make("t2"),
        taskId: busy.id,
        session: RUNNING_SESSION,
        latestUserMessageAt: "2026-10-01T11:00:00.000Z",
      }),
    ];
    const columns = groupTaskboardTasks([quiet, busy, blocked, archived], (entry) =>
      entry.id === busy.id ? busyThreads : [],
    );

    const working = columns.get("working") ?? [];
    expect(working.map((card) => card.task.id)).toEqual(["busy", "quiet"]);
    expect(working[0]).toMatchObject({
      status: "working",
      latestThread: { id: "t2" },
      activityAt: "2026-10-01T11:00:00.000Z",
    });
    expect(working[1]).toMatchObject({ latestThread: null, activityAt: quiet.updatedAt });
    expect(columns.get("needs-you")?.map((card) => card.task.id)).toEqual(["blocked"]);
    expect(columns.get("archive")?.map((card) => card.task.id)).toEqual(["old"]);
    expect(columns.get("in-review")).toEqual([]);
  });
});
