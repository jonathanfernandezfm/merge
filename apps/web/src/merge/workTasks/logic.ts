import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  deriveWorkTaskStatus,
  WORK_TASK_STATUSES,
  workTaskPullRequestFromSnapshot,
  workTaskStatusInputs,
  workTaskThreadState,
  type ContextMenuItem,
  type EnvironmentId,
  type ThreadId,
  type VcsRef,
  type WorkTask,
  type WorkTaskId,
  type WorkTaskLink,
  type WorkTaskPullRequestView,
  type WorkTaskStatus,
  type WorkTaskThreadOrigin,
} from "@t3tools/contracts";

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
      }),
    });
    const latestThread = latestWorkTaskThread(tabs);
    const latestActivity = latestThread === null ? null : threadActivityAt(latestThread);
    views.set(key, {
      key,
      task,
      tabs,
      status,
      pullRequest: workTaskPullRequestSummary(task, members),
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
      ...workTaskPullRequestFromSnapshot(link.snapshot),
    };
  }
  return task.legacyPullRequest;
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

export const WORK_TASK_SORTS = [
  { value: "newest", label: "Newest" },
  { value: "activity", label: "Recent activity" },
  { value: "status", label: "Status" },
] as const;
export type WorkTaskSort = (typeof WORK_TASK_SORTS)[number]["value"];

/** Status follows the task lifecycle; activity breaks ties so the task touched last leads. */
function sortWorkTasks(
  views: ReadonlyArray<WorkTaskView>,
  sort: WorkTaskSort,
): ReadonlyArray<WorkTaskView> {
  if (sort === "newest") {
    return views.toSorted((left, right) => right.task.createdAt.localeCompare(left.task.createdAt));
  }
  const rank = (view: WorkTaskView) =>
    sort === "status" ? WORK_TASK_STATUSES.indexOf(view.status) : 0;
  return views.toSorted((left, right) => rank(left) - rank(right) || byActivity(left, right));
}

function workTaskMatchesQuery(task: EnvironmentWorkTask, query: string): boolean {
  return (
    task.title.toLowerCase().includes(query) || task.workspace.branch.toLowerCase().includes(query)
  );
}

export interface WorkTaskProjectGroup {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: EnvironmentWorkTask["projectId"];
  readonly title: string;
  readonly views: ReadonlyArray<WorkTaskView>;
}

/**
 * The sidebar's project groups: every visible project with its active tasks in the chosen
 * order. Searching narrows to projects with a task whose title or branch matches, hidden
 * projects included, so a match never disappears. Archived tasks never show.
 */
export function groupSidebarWorkTasks(input: {
  readonly views: Iterable<WorkTaskView>;
  readonly projects: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: EnvironmentWorkTask["projectId"];
    readonly title: string;
  }>;
  readonly hiddenProjectKeys: ReadonlySet<string>;
  readonly query: string;
  readonly sort: WorkTaskSort;
}): ReadonlyArray<WorkTaskProjectGroup> {
  const query = input.query.trim().toLowerCase();
  const searching = query.length > 0;
  const byProject = new Map<string, WorkTaskView[]>();
  for (const view of input.views) {
    if (view.task.archivedAt !== null) continue;
    if (searching && !workTaskMatchesQuery(view.task, query)) continue;
    const key = `${view.task.environmentId}:${view.task.projectId}`;
    const list = byProject.get(key);
    if (list === undefined) byProject.set(key, [view]);
    else list.push(view);
  }
  return input.projects.flatMap((project) => {
    const key = `${project.environmentId}:${project.id}`;
    const views = byProject.get(key) ?? [];
    if (searching ? views.length === 0 : input.hiddenProjectKeys.has(key)) return [];
    return [
      {
        key,
        environmentId: project.environmentId,
        projectId: project.id,
        title: project.title,
        views: sortWorkTasks(views, input.sort),
      },
    ];
  });
}

export type WorkTaskMenuId =
  | "new-thread"
  | "mark-waiting"
  | "clear-waiting"
  | "auto-handle"
  | "archive"
  | `open-linked:${number}`;

/** The task right-click menu, shared by the sidebar row and the board card. */
export function workTaskMenuItems(input: {
  readonly task: EnvironmentWorkTask;
  readonly linkedProjectTitles: ReadonlyArray<string>;
  /** False on a read-only connection: only navigation stays enabled. */
  readonly canOperate: boolean;
}): ReadonlyArray<ContextMenuItem<WorkTaskMenuId>> {
  const { task, linkedProjectTitles } = input;
  const archived = task.archivedAt !== null || !input.canOperate;
  return [
    { id: "new-thread", label: "New thread", disabled: archived },
    ...linkedProjectTitles.map((title, index) => ({
      id: `open-linked:${index}` as const,
      label: `Open in ${title}`,
      separatorBefore: index === 0,
    })),
    task.waitingForUserReason !== null
      ? {
          id: "clear-waiting",
          label: "Clear waiting for user",
          disabled: !input.canOperate,
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
      checked: task.autoHandleReviewFeedback,
      disabled: archived,
    },
    {
      id: "archive",
      label: "Archive Work Task...",
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

/** Trailing separators dropped; the server also resolves symlinks, which a client cannot. */
function normalizeWorktreePath(path: string): string {
  const trimmed = path.trim();
  return trimmed.length > 1 ? trimmed.replace(/[\\/]+$/, "") : trimmed;
}

/** True when a live (not archived) Work Task in the environment owns this worktree path. */
export function workTaskOwnsWorktreePath(
  tasks: ReadonlyArray<EnvironmentWorkTask>,
  environmentId: EnvironmentId,
  worktreePath: string,
): boolean {
  const target = normalizeWorktreePath(worktreePath);
  return tasks.some(
    (task) =>
      task.environmentId === environmentId &&
      task.archivedAt === null &&
      task.workspace.path !== null &&
      normalizeWorktreePath(task.workspace.path) === target,
  );
}
