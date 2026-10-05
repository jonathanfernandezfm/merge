import type {
  OrchestrationTaskShell,
  OrchestrationThreadShell,
  TaskId,
  ThreadOrigin,
} from "@t3tools/contracts";
import {
  deriveTaskStatus,
  type TaskStatus,
  type TaskStatusTone,
  type TaskThreadState,
} from "@t3tools/shared/taskStatus";

/** The thread shell fields task status and tabs read. */
export type TaskThreadShell = Pick<
  OrchestrationThreadShell,
  | "id"
  | "taskId"
  | "origin"
  | "title"
  | "session"
  | "latestTurn"
  | "backgroundLiveness"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "settledOverride"
  | "archivedAt"
  | "createdAt"
  | "updatedAt"
  | "latestUserMessageAt"
>;

/**
 * The one mapping from a thread shell to what `deriveTaskStatus` needs.
 * Pending approvals and questions outrank a running turn: the agent is
 * blocked on the user either way. Subagents still working after the turn
 * settles keep the thread running, unless the session failed; watch loops
 * (`monitoring`) do not, matching the sidebar's thread status.
 */
export function taskThreadState(
  thread: Pick<
    TaskThreadShell,
    "session" | "latestTurn" | "backgroundLiveness" | "hasPendingApprovals" | "hasPendingUserInput"
  >,
): TaskThreadState {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "waiting";
  const status = thread.session?.status;
  if (status === "starting" || status === "running") return "running";
  if (status !== "error" && thread.backgroundLiveness === "working") return "running";
  return thread.latestTurn === null ? "new" : "idle";
}

/** Absent or null origins are threads people started. */
export function isAutomatedThreadOrigin(origin: ThreadOrigin | null | undefined): boolean {
  return origin != null && origin !== "user";
}

/** A task's live threads (not archived), oldest first: the order of its tabs. */
export function taskThreadsInOrder<T extends TaskThreadShell>(
  threads: ReadonlyArray<T>,
  taskId: TaskId,
): ReadonlyArray<T> {
  return threads
    .filter((thread) => thread.taskId === taskId && thread.archivedAt === null)
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
}

function threadActivityAt(thread: TaskThreadShell): string {
  return thread.latestUserMessageAt ?? thread.updatedAt;
}

/** The newer of a task's update and its latest thread's activity. */
export function taskActivityAt(
  task: Pick<OrchestrationTaskShell, "updatedAt">,
  latestThread: TaskThreadShell | null,
): string {
  const threadActivity = latestThread === null ? null : threadActivityAt(latestThread);
  return threadActivity !== null && threadActivity > task.updatedAt
    ? threadActivity
    : task.updatedAt;
}

/** The thread opening a task lands on: its most recently active live thread. */
export function latestTaskThread<T extends TaskThreadShell>(threads: ReadonlyArray<T>): T | null {
  let latest: T | null = null;
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    if (latest === null || threadActivityAt(thread) > threadActivityAt(latest)) {
      latest = thread;
    }
  }
  return latest;
}

/** A task's status from its own threads, through the shared `deriveTaskStatus`. */
export function resolveTaskStatus(
  task: OrchestrationTaskShell,
  threads: ReadonlyArray<TaskThreadShell>,
): TaskStatus {
  return deriveTaskStatus({
    task,
    threads: threads
      .filter((thread) => thread.taskId === task.id && thread.archivedAt === null)
      .map((thread) => ({ origin: thread.origin, state: taskThreadState(thread) })),
  });
}

/** The glyph a thread tab shows: running, idle, blocked on the user, or settled. */
export type TaskThreadTabState = "running" | "idle" | "waiting" | "completed";

export function taskThreadTabState(
  thread: Pick<
    TaskThreadShell,
    | "session"
    | "latestTurn"
    | "backgroundLiveness"
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "settledOverride"
  >,
): TaskThreadTabState {
  const state = taskThreadState(thread);
  if (state === "waiting" || state === "running") return state;
  return thread.settledOverride === "settled" ? "completed" : "idle";
}

export type TaskboardColumnId =
  | "working"
  | "needs-you"
  | "in-review"
  | "ready-to-merge"
  | "archive";

/** The board's columns in order; `archive` renders as the collapsible footer. */
export const TASKBOARD_COLUMNS: ReadonlyArray<{
  readonly id: TaskboardColumnId;
  readonly label: string;
  readonly tone: TaskStatusTone;
}> = [
  { id: "working", label: "Working", tone: "info" },
  { id: "needs-you", label: "Needs you", tone: "warning" },
  { id: "in-review", label: "In review", tone: "neutral" },
  { id: "ready-to-merge", label: "Ready to merge", tone: "success" },
  { id: "archive", label: "Archive", tone: "neutral" },
];

/** Where a task with this status sits on the Taskboard. */
export function taskboardColumnForStatus(status: TaskStatus): TaskboardColumnId {
  switch (status) {
    case "setting-up":
    case "working":
    case "idle":
    case "addressing-comments":
      return "working";
    case "waiting-for-user":
    case "setup-failed":
    case "ci-failing":
    case "changes-requested":
      return "needs-you";
    case "ci-running":
    case "waiting-for-review":
      return "in-review";
    case "approved":
    case "merge-ready":
      return "ready-to-merge";
    case "merged":
    case "archived":
      return "archive";
    default: {
      const unhandled: never = status;
      return unhandled;
    }
  }
}

export interface TaskboardCard<K, T> {
  readonly task: K;
  readonly status: TaskStatus;
  /** The thread opening the card lands on, or null when every tab is closed. */
  readonly latestThread: T | null;
  /** The newer of the task's update and its latest thread's activity. */
  readonly activityAt: string;
}

/**
 * One card per task, grouped into the Taskboard columns, each column most
 * recently active first.
 */
export function groupTaskboardTasks<K extends OrchestrationTaskShell, T extends TaskThreadShell>(
  tasks: ReadonlyArray<K>,
  threadsOf: (task: K) => ReadonlyArray<T>,
): ReadonlyMap<TaskboardColumnId, ReadonlyArray<TaskboardCard<K, T>>> {
  const columns = new Map<TaskboardColumnId, Array<TaskboardCard<K, T>>>(
    TASKBOARD_COLUMNS.map((column) => [column.id, []]),
  );
  for (const task of tasks) {
    const threads = threadsOf(task);
    const status = resolveTaskStatus(task, threads);
    const latestThread = latestTaskThread(threads);
    const activityAt = taskActivityAt(task, latestThread);
    columns.get(taskboardColumnForStatus(status))!.push({ task, status, latestThread, activityAt });
  }
  for (const column of columns.values()) {
    column.sort(
      (left, right) =>
        right.activityAt.localeCompare(left.activityAt) ||
        left.task.id.localeCompare(right.task.id),
    );
  }
  return columns;
}
