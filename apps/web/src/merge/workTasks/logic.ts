import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  deriveWorkTaskStatus,
  workTaskPullRequestFromSnapshot,
  workTaskStatusInputs,
  workTaskThreadState,
  type ContextMenuItem,
  type EnvironmentId,
  type ThreadId,
  type VcsRef,
  type WorkTask,
  type WorkTaskInsight,
  type WorkTaskPullRequestFacts,
  type WorkTaskId,
  type WorkTaskLink,
  type WorkTaskPullRequestView,
  type WorkTaskStatus,
  type WorkTaskThreadOrigin,
  type WorkTasksSnapshot,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import type { WorkTaskItem, WorkTaskItemMember } from "./grouping";

export interface EnvironmentWorkTask extends WorkTask {
  readonly environmentId: EnvironmentId;
}

export interface WorkTaskTab {
  readonly shell: EnvironmentThreadShell;
  readonly origin: WorkTaskThreadOrigin | null;
}

export interface WorkTaskPullRequestSummary extends WorkTaskPullRequestView {
  readonly number: number;
  readonly url: string;
  readonly title: string;
}

/** A Work Task joined with its threads: what every surface renders. */
export interface WorkTaskView {
  readonly key: string;
  readonly task: EnvironmentWorkTask;
  /** Live linked threads in creation order: the task bar's tabs. */
  readonly tabs: ReadonlyArray<WorkTaskTab>;
  readonly status: WorkTaskStatus;
  readonly pullRequest: WorkTaskPullRequestSummary | null;
  /** The thread opening the task lands on, or null when every tab is closed. */
  readonly latestThread: EnvironmentThreadShell | null;
  /** The newer of the task's update and its latest thread's activity. */
  readonly activityAt: string;
}

export function workTaskKey(environmentId: EnvironmentId, taskId: WorkTaskId): string {
  return `${environmentId}\u0000${taskId}`;
}

function threadActivityAt(shell: EnvironmentThreadShell): string {
  return shell.latestUserMessageAt ?? shell.updatedAt;
}

function isLive(shell: EnvironmentThreadShell): boolean {
  return shell.archivedAt === null && shell.deletedAt === null;
}

/**
 * Joins every task with its environment's links and thread shells. Members are linked threads
 * plus their subagent descendants (status only); tabs are the live linked threads.
 */
export function buildWorkTaskViews(input: {
  readonly tasks: ReadonlyArray<EnvironmentWorkTask>;
  readonly linksByEnvironment: ReadonlyMap<EnvironmentId, ReadonlyArray<WorkTaskLink>>;
  readonly shells: ReadonlyArray<EnvironmentThreadShell>;
  /** Per-task insights keyed like `WorkTaskView.key`; absent means no facts. */
  readonly insights?: ReadonlyMap<string, WorkTaskInsight>;
}): ReadonlyMap<string, WorkTaskView> {
  const linkByThread = new Map<string, WorkTaskLink>();
  for (const [environmentId, links] of input.linksByEnvironment) {
    for (const link of links) linkByThread.set(`${environmentId}\u0000${link.threadId}`, link);
  }
  const membersByTask = new Map<string, EnvironmentThreadShell[]>();
  for (const shell of input.shells) {
    const link =
      linkByThread.get(`${shell.environmentId}\u0000${shell.id}`) ??
      (shell.lineage.relationshipToParent === "subagent"
        ? linkByThread.get(`${shell.environmentId}\u0000${shell.lineage.rootThreadId}`)
        : undefined);
    if (link === undefined) continue;
    const key = workTaskKey(shell.environmentId, link.taskId);
    const members = membersByTask.get(key);
    if (members === undefined) membersByTask.set(key, [shell]);
    else members.push(shell);
  }

  const views = new Map<string, WorkTaskView>();
  for (const task of input.tasks) {
    const key = workTaskKey(task.environmentId, task.id);
    const members = (membersByTask.get(key) ?? []).filter(isLive);
    const links = input.linksByEnvironment.get(task.environmentId) ?? [];
    const tabs = members
      .flatMap((shell) => {
        const link = linkByThread.get(`${shell.environmentId}\u0000${shell.id}`);
        return link === undefined ? [] : [{ shell, origin: link.origin }];
      })
      .sort(
        (left, right) =>
          left.shell.createdAt.localeCompare(right.shell.createdAt) ||
          left.shell.id.localeCompare(right.shell.id),
      );
    const status = deriveWorkTaskStatus({
      task,
      ...workTaskStatusInputs({
        taskId: task.id,
        task,
        links,
        shells: members.map((shell) => shell.source),
        facts: input.insights?.get(key)?.pullRequest ?? null,
      }),
    });
    const latestThread = latestWorkTaskThread(tabs);
    const latestActivity = latestThread === null ? null : threadActivityAt(latestThread);
    views.set(key, {
      key,
      task,
      tabs,
      status,
      pullRequest: workTaskPullRequestSummary(
        task,
        members,
        input.insights?.get(key)?.pullRequest ?? null,
      ),
      latestThread,
      activityAt:
        latestActivity !== null && latestActivity > task.updatedAt
          ? latestActivity
          : task.updatedAt,
    });
  }
  return views;
}

/** Same selection as status: the newest link on the task branch, else the legacy row. */
function workTaskPullRequestSummary(
  task: EnvironmentWorkTask,
  members: ReadonlyArray<EnvironmentThreadShell>,
  facts: WorkTaskPullRequestFacts | null,
): WorkTaskPullRequestSummary | null {
  const link = members
    .flatMap((shell) => shell.pullRequests)
    .filter((candidate) => candidate.snapshot?.headBranch === task.workspace.branch)
    .sort((a, b) => b.linkedAt.localeCompare(a.linkedAt))[0];
  if (link?.snapshot) {
    return {
      number: link.number,
      url: link.url,
      title: link.snapshot.title,
      ...workTaskPullRequestFromSnapshot(
        link.snapshot,
        facts?.number === link.number ? facts : null,
      ),
    };
  }
  const legacy = task.legacyPullRequest;
  return legacy && { ...legacy, mergeConflicts: false, unresolvedComments: 0 };
}

function latestWorkTaskThread(tabs: ReadonlyArray<WorkTaskTab>): EnvironmentThreadShell | null {
  let latest: EnvironmentThreadShell | null = null;
  for (const { shell } of tabs) {
    if (latest === null || threadActivityAt(shell) > threadActivityAt(latest)) latest = shell;
  }
  return latest;
}

/** The glyph a thread tab shows: running, watching, idle, blocked on the user, or settled. */
export type WorkTaskTabState = "running" | "monitoring" | "idle" | "waiting" | "completed";

export function workTaskTabState(shell: EnvironmentThreadShell): WorkTaskTabState {
  const state = workTaskThreadState(shell.source);
  if (state === "waiting" || state === "running" || state === "monitoring") return state;
  return shell.settledAt !== null ? "completed" : "idle";
}

export type WorkTaskboardColumnId =
  | "working"
  | "needs-you"
  | "in-review"
  | "ready-to-merge"
  | "merged"
  | "archive";

export type WorkTaskStatusTone = "neutral" | "info" | "success" | "warning" | "danger";

/** The board's columns in order; `archive` renders as the collapsible footer. */
export const WORK_TASKBOARD_COLUMNS: ReadonlyArray<{
  readonly id: WorkTaskboardColumnId;
  readonly label: string;
  readonly tone: WorkTaskStatusTone;
}> = [
  { id: "working", label: "Working", tone: "info" },
  { id: "needs-you", label: "Needs you", tone: "warning" },
  { id: "in-review", label: "In review", tone: "neutral" },
  { id: "ready-to-merge", label: "Ready to merge", tone: "success" },
  { id: "merged", label: "Merged", tone: "success" },
  { id: "archive", label: "Archive", tone: "neutral" },
];

export function workTaskboardColumnForStatus(status: WorkTaskStatus): WorkTaskboardColumnId {
  switch (status) {
    case "setting-up":
    case "working":
    case "monitoring":
    case "idle":
    case "addressing-comments":
      return "working";
    case "waiting-for-user":
    case "setup-failed":
    case "merge-conflicts":
    case "changes-requested":
    case "unresolved-comments":
    case "approved-checks-failing":
      return "needs-you";
    case "waiting-for-review":
      return "in-review";
    case "approved":
      return "ready-to-merge";
    case "merged":
      return "merged";
    case "archived":
      return "archive";
    default: {
      const unhandled: never = status;
      return unhandled;
    }
  }
}

/** Cards grouped into the board's columns, each column most recently active first. */
export function groupWorkTaskboard(
  views: Iterable<WorkTaskView>,
): ReadonlyMap<WorkTaskboardColumnId, ReadonlyArray<WorkTaskView>> {
  const columns = new Map<WorkTaskboardColumnId, WorkTaskView[]>(
    WORK_TASKBOARD_COLUMNS.map((column) => [column.id, []]),
  );
  for (const view of views) columns.get(workTaskboardColumnForStatus(view.status))!.push(view);
  for (const column of columns.values()) column.sort(byActivity);
  return columns;
}

function byActivity(left: WorkTaskView, right: WorkTaskView): number {
  return right.activityAt.localeCompare(left.activityAt) || left.key.localeCompare(right.key);
}

/**
 * Live tasks on the same branch as another live task: one piece of work split across
 * repositories. Maps a task key to the other tasks on its branch; tasks without one are absent.
 */
export function linkedWorkTasksByKey(
  tasks: ReadonlyArray<EnvironmentWorkTask>,
): ReadonlyMap<string, ReadonlyArray<EnvironmentWorkTask>> {
  const byBranch = new Map<string, EnvironmentWorkTask[]>();
  for (const task of tasks) {
    if (task.archivedAt !== null) continue;
    const group = byBranch.get(task.workspace.branch);
    if (group === undefined) byBranch.set(task.workspace.branch, [task]);
    else group.push(task);
  }
  const linked = new Map<string, ReadonlyArray<EnvironmentWorkTask>>();
  for (const group of byBranch.values()) {
    if (group.length < 2) continue;
    for (const task of group) {
      linked.set(
        workTaskKey(task.environmentId, task.id),
        group.filter((other) => other !== task),
      );
    }
  }
  return linked;
}

/**
 * `next` with each insight equal by value to the previous one kept as that object, and the
 * previous map itself when nothing changed: every WS message decodes to new objects.
 */
export function keepInsightIdentities(
  previous: ReadonlyMap<string, WorkTaskInsight>,
  next: ReadonlyMap<string, WorkTaskInsight>,
): ReadonlyMap<string, WorkTaskInsight> {
  let changed = previous.size !== next.size;
  const kept = new Map<string, WorkTaskInsight>();
  for (const [key, value] of next) {
    const before = previous.get(key);
    const same = before !== undefined && JSON.stringify(before) === JSON.stringify(value);
    if (!same) changed = true;
    kept.set(key, same ? before : value);
  }
  return changed ? kept : previous;
}

/** The member a click opens and "copy branch" reads: the one touched last. */
export function latestWorkTaskMember(item: WorkTaskItem): WorkTaskItemMember {
  return item.members.reduce((best, member) =>
    member.view.activityAt > best.view.activityAt ? member : best,
  );
}

/**
 * The work item right-click menu, shared by the sidebar row and the board card. Waiting,
 * auto-handle and rename apply to every member; `open-linked:<i>` to the latest member's siblings.
 */
export function workTaskItemMenuItems(
  item: WorkTaskItem,
  options: {
    readonly linkedProjectTitles?: ReadonlyArray<string>;
    /** False on a read-only connection: only navigation and copy stay enabled. */
    readonly canOperate?: boolean;
  } = {},
): ContextMenuItem<string>[] {
  const { linkedProjectTitles = [], canOperate = true } = options;
  const tasks = item.members.map((member) => member.view.task);
  const single = item.members.length === 1;
  const archived = tasks.every((task) => task.archivedAt !== null) || !canOperate;
  const withPr = item.members.flatMap((member, index) =>
    member.view.pullRequest === null
      ? []
      : [{ member, index, pullRequest: member.view.pullRequest }],
  );
  return [
    // A click opens the latest member; this reaches the others. One member needs no entry.
    ...(single
      ? []
      : [
          {
            id: "open-task",
            label: "Open task in",
            children: item.members.map((member, index) => ({
              id: `open-task:${index}`,
              label: member.label,
            })),
          },
        ]),
    {
      id: "open-ado",
      label: "Open in Azure DevOps",
      disabled: !item.workItem?.url,
      separatorBefore: !single,
    },
    {
      id: "copy-id",
      label: "Copy work item ID",
      disabled: item.workItem === null,
      ...(item.workItem !== null ? { detail: String(item.workItem.id) } : {}),
    },
    { id: "copy-branch", label: "Copy branch name" },
    // One member needs no submenu: the action sits directly in the menu.
    single
      ? {
          id: "open-pr:0",
          label: "Open pull request",
          disabled: withPr.length === 0,
        }
      : {
          id: "open-pr",
          label: "Open pull request",
          disabled: withPr.length === 0,
          children: withPr.map(({ member, index, pullRequest }) => ({
            id: `open-pr:${index}`,
            label: `${member.label} #${pullRequest.number}`,
          })),
        },
    single
      ? { id: "new-thread:0", label: "New thread", disabled: archived }
      : {
          id: "new-thread",
          label: "New thread in",
          disabled: archived,
          children: item.members.map((member, index) => ({
            id: `new-thread:${index}`,
            label: member.label,
          })),
        },
    ...linkedProjectTitles.map((title, index) => ({
      id: `open-linked:${index}`,
      label: `Open in ${title}`,
      separatorBefore: index === 0,
    })),
    { id: "rename", label: "Rename...", disabled: archived, separatorBefore: true },
    // Naming reads the ADO item, so without one there is nothing to name from.
    { id: "rename-ai", label: "Rename with AI", disabled: archived || item.workItem === null },
    tasks.some((task) => task.waitingForUserReason !== null)
      ? {
          id: "clear-waiting",
          label: "Clear waiting for user",
          disabled: !canOperate,
          separatorBefore: true,
        }
      : {
          id: "mark-waiting",
          label: "Mark waiting for user...",
          disabled: archived,
          separatorBefore: true,
        },
    {
      id: "auto-handle",
      label: "Auto-handle PR feedback",
      checked: tasks.every((task) => task.autoHandleReviewFeedback),
      disabled: archived,
    },
    {
      id: "archive",
      label: "Archive",
      destructive: true,
      disabled: archived,
      separatorBefore: true,
    },
  ];
}

/**
 * Suggests a title from the branch: the type prefix (`feature/`) is dropped, separators become
 * spaces, and a leading issue number keeps its own label (`feature/#533-mx2-review` ->
 * `#533: mx2 review`).
 */
export function workTaskTitleFromBranch(branch: string): string {
  const name = branch.slice(branch.lastIndexOf("/") + 1);
  const words = (value: string) => value.replace(/[-_]+/g, " ").trim().replace(/\s+/g, " ");
  const issue = /^(#\d+)[-_]+(.+)$/.exec(name);
  if (issue !== null) {
    const rest = words(issue[2]!);
    return rest.length > 0 ? `${issue[1]}: ${rest}` : issue[1]!;
  }
  return words(name);
}

/** A remote ref as the branch picker offers it: `origin/feature` checks out `feature`. */
export function remoteBranchOf(ref: VcsRef): { remoteName: string; branch: string } | null {
  if (!ref.isRemote || !ref.remoteName) return null;
  const prefix = `${ref.remoteName}/`;
  if (!ref.name.startsWith(prefix)) return null;
  const branch = ref.name.slice(prefix.length);
  return branch.length === 0 || branch === "HEAD" ? null : { remoteName: ref.remoteName, branch };
}

/** The task a thread belongs to, from its link or its subagent root's link. */
export function workTaskIdOfThread(
  links: ReadonlyArray<WorkTaskLink>,
  shell: Pick<EnvironmentThreadShell, "id" | "lineage"> | null,
  threadId: ThreadId,
): WorkTaskId | null {
  const byThread = (id: string) => links.find((link) => link.threadId === id)?.taskId ?? null;
  return (
    byThread(threadId) ??
    (shell?.lineage.relationshipToParent === "subagent"
      ? byThread(shell.lineage.rootThreadId)
      : null)
  );
}

/** `${environmentId}\0${threadId}` of every thread linked to a Work Task. */
export function workTaskThreadKeys(
  linksByEnvironment: ReadonlyMap<EnvironmentId, ReadonlyArray<WorkTaskLink>>,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const [environmentId, links] of linksByEnvironment) {
    for (const link of links) keys.add(`${environmentId}\u0000${link.threadId}`);
  }
  return keys;
}

/** The threads that belong to no Work Task; a subagent goes with its root thread. */
export function threadsOutsideWorkTasks<
  T extends Pick<EnvironmentThreadShell, "environmentId" | "id" | "lineage">,
>(threads: ReadonlyArray<T>, taskThreadKeys: ReadonlySet<string>): ReadonlyArray<T> {
  if (taskThreadKeys.size === 0) return threads;
  const kept = threads.filter(
    (thread) =>
      !taskThreadKeys.has(`${thread.environmentId}\u0000${thread.id}`) &&
      !(
        thread.lineage.relationshipToParent === "subagent" &&
        taskThreadKeys.has(`${thread.environmentId}\u0000${thread.lineage.rootThreadId}`)
      ),
  );
  return kept.length === threads.length ? threads : kept;
}

/** Trailing separators dropped; the server also resolves symlinks, which a client cannot. */
function normalizeWorktreePath(path: string): string {
  const trimmed = path.trim();
  return trimmed.length > 1 ? trimmed.replace(/[\\/]+$/, "") : trimmed;
}

/**
 * An environment's tasks from its subscription: null while loading, none when the stream failed
 * (e.g. a server without Work Tasks).
 */
export function loadedWorkTasks(
  result: AsyncResult.AsyncResult<WorkTasksSnapshot, unknown>,
): ReadonlyArray<WorkTask> | null {
  const snapshot = Option.getOrNull(AsyncResult.value(result));
  if (snapshot !== null) return snapshot.tasks;
  return result._tag === "Failure" ? [] : null;
}

/**
 * True when a live (not archived) Work Task of the environment owns this worktree path. `tasks` is
 * null while the environment's snapshot has not loaded: unknown counts as owned, so nothing can be
 * deleted on a guess.
 */
export function workTaskOwnsWorktreePath(
  tasks: ReadonlyArray<Pick<WorkTask, "archivedAt" | "workspace">> | null,
  worktreePath: string,
): boolean {
  if (tasks === null) return true;
  const target = normalizeWorktreePath(worktreePath);
  return tasks.some(
    (task) =>
      task.archivedAt === null &&
      task.workspace.path !== null &&
      normalizeWorktreePath(task.workspace.path) === target,
  );
}
