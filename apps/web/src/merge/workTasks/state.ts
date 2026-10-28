import { useAtomValue } from "@effect/atom-react";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { arrayElementsEqual } from "@t3tools/client-runtime/state/entities";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  MERGE_WS_METHODS,
  type EnvironmentId,
  type ScopedThreadRef,
  type WorkTaskId,
  type WorkTaskLink,
  type WorkTasksSnapshot,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "~/connection/catalog";
import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentThreadShells } from "~/state/threads";
import {
  buildWorkTaskViews,
  linkedWorkTasksByKey,
  workTaskIdOfThread,
  loadedWorkTasks,
  threadsOutsideWorkTasks,
  workTaskOwnsWorktreePath,
  workTaskKey,
  workTaskThreadKeys,
  type EnvironmentWorkTask,
  type WorkTaskView,
} from "./logic";

const live = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:merge:work-tasks",
  tag: MERGE_WS_METHODS.workTasksSubscribe,
});

const taskCommand = <
  TTag extends
    | typeof MERGE_WS_METHODS.workTasksRetrySetup
    | typeof MERGE_WS_METHODS.workTasksCreateThread
    | typeof MERGE_WS_METHODS.workTasksArchive
    | typeof MERGE_WS_METHODS.workTasksSetWaiting
    | typeof MERGE_WS_METHODS.workTasksSetAutoHandle,
>(
  label: string,
  tag: TTag,
) =>
  createEnvironmentRpcCommand(connectionAtomRuntime, {
    label,
    tag,
    concurrency: {
      mode: "serial",
      key: ({ environmentId, input }) => `${environmentId}:${input.taskId}`,
    },
  });

export const workTasksEnvironment = {
  create: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:merge:work-tasks-create",
    tag: MERGE_WS_METHODS.workTasksCreate,
  }),
  // Read fresh each time the archive dialog opens; the workspace changes under it.
  archiveCheck: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:merge:work-tasks-archive-check",
    tag: MERGE_WS_METHODS.workTasksArchiveCheck,
    staleTimeMs: 0,
    idleTtlMs: 0,
  }),
  // Fetches the primary remote before listing, so it is kept for a minute rather than refetched.
  listBranches: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:merge:work-tasks-list-branches",
    tag: MERGE_WS_METHODS.workTasksListBranches,
    staleTimeMs: 60_000,
  }),
  retrySetup: taskCommand(
    "environment-data:merge:work-tasks-retry",
    MERGE_WS_METHODS.workTasksRetrySetup,
  ),
  createThread: taskCommand(
    "environment-data:merge:work-tasks-create-thread",
    MERGE_WS_METHODS.workTasksCreateThread,
  ),
  archive: taskCommand(
    "environment-data:merge:work-tasks-archive",
    MERGE_WS_METHODS.workTasksArchive,
  ),
  setWaiting: taskCommand(
    "environment-data:merge:work-tasks-set-waiting",
    MERGE_WS_METHODS.workTasksSetWaiting,
  ),
  setAutoHandle: taskCommand(
    "environment-data:merge:work-tasks-set-auto-handle",
    MERGE_WS_METHODS.workTasksSetAutoHandle,
  ),
};

const EMPTY_LINKS: ReadonlyArray<WorkTaskLink> = [];

/** The live snapshot per environment; environments without Work Tasks (or offline) read empty. */
const snapshotAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): WorkTasksSnapshot | null =>
    Option.getOrNull(AsyncResult.value(get(live({ environmentId, input: {} })))),
  ).pipe(Atom.withLabel(`merge-work-tasks-snapshot:${environmentId}`)),
);

// One scoped object per source task, so unchanged tasks keep their identity across snapshots.
const scopedTasks = new WeakMap<object, EnvironmentWorkTask>();

let previousTasks: ReadonlyArray<EnvironmentWorkTask> = [];
/** Every Work Task across enabled environments, archived ones included. */
const workTasksAtom = Atom.make((get) => {
  const next: EnvironmentWorkTask[] = [];
  for (const environmentId of enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))) {
    for (const task of get(snapshotAtom(environmentId))?.tasks ?? []) {
      if (task.deletedAt !== null) continue;
      let scoped = scopedTasks.get(task);
      if (scoped === undefined) {
        scoped = { ...task, environmentId };
        scopedTasks.set(task, scoped);
      }
      next.push(scoped);
    }
  }
  if (arrayElementsEqual(previousTasks, next)) return previousTasks;
  previousTasks = next;
  return next;
}).pipe(Atom.withLabel("merge-work-tasks"));

const linksByEnvironmentAtom = Atom.make((get) => {
  const next = new Map<EnvironmentId, ReadonlyArray<WorkTaskLink>>();
  for (const environmentId of enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))) {
    next.set(environmentId, get(snapshotAtom(environmentId))?.links ?? EMPTY_LINKS);
  }
  return next;
}).pipe(Atom.withLabel("merge-work-task-links"));

const workTaskThreadKeysAtom = Atom.make((get) =>
  workTaskThreadKeys(get(linksByEnvironmentAtom)),
).pipe(Atom.withLabel("merge-work-task-thread-keys"));

/** The Threads list leaves a Work Task's threads to the task. */
export function useThreadsOutsideWorkTasks<
  T extends Pick<EnvironmentThreadShell, "environmentId" | "id" | "lineage">,
>(threads: ReadonlyArray<T>): ReadonlyArray<T> {
  return threadsOutsideWorkTasks(threads, useAtomValue(workTaskThreadKeysAtom));
}

let previousViews: ReadonlyMap<string, WorkTaskView> = new Map();
/**
 * Every task joined with its threads. Reads the quiet shells, so streaming ticks do not rebuild
 * it; a view keeps its identity while its task, tabs and status are unchanged.
 */
const workTaskViewsAtom = Atom.make((get) => {
  const built = buildWorkTaskViews({
    tasks: get(workTasksAtom),
    linksByEnvironment: get(linksByEnvironmentAtom),
    shells: get(environmentThreadShells.quietThreadShellsAtom),
  });
  const next = new Map<string, WorkTaskView>();
  for (const [key, view] of built) {
    const before = previousViews.get(key);
    next.set(
      key,
      before !== undefined &&
        before.task === view.task &&
        before.status === view.status &&
        before.activityAt === view.activityAt &&
        before.latestThread === view.latestThread &&
        JSON.stringify(before.pullRequest) === JSON.stringify(view.pullRequest) &&
        before.tabs.length === view.tabs.length &&
        before.tabs.every(
          (tab, index) =>
            tab.shell === view.tabs[index]?.shell && tab.origin === view.tabs[index]?.origin,
        )
        ? before
        : view,
    );
  }
  previousViews = next;
  return next;
}).pipe(Atom.withLabel("merge-work-task-views"));

let previousLinked: ReadonlyMap<string, ReadonlyArray<EnvironmentWorkTask>> = new Map();
const linkedWorkTasksAtom = Atom.make((get) => {
  const next = new Map<string, ReadonlyArray<EnvironmentWorkTask>>();
  for (const [key, siblings] of linkedWorkTasksByKey(get(workTasksAtom))) {
    const before = previousLinked.get(key);
    next.set(key, before !== undefined && arrayElementsEqual(before, siblings) ? before : siblings);
  }
  previousLinked = next;
  return next;
}).pipe(Atom.withLabel("merge-linked-work-tasks"));

export function useWorkTaskViews(): ReadonlyMap<string, WorkTaskView> {
  return useAtomValue(workTaskViewsAtom);
}

export function useLinkedWorkTasks(): ReadonlyMap<string, ReadonlyArray<EnvironmentWorkTask>> {
  return useAtomValue(linkedWorkTasksAtom);
}

export function useWorkTaskView(
  environmentId: EnvironmentId | null,
  taskId: WorkTaskId | null,
): WorkTaskView | null {
  const views = useWorkTaskViews();
  return environmentId === null || taskId === null
    ? null
    : (views.get(workTaskKey(environmentId, taskId)) ?? null);
}

/** The Work Task a thread (or its subagent root) belongs to, or null outside a task. */
export function useThreadWorkTask(threadRef: ScopedThreadRef | null): WorkTaskView | null {
  const views = useWorkTaskViews();
  const links = useAtomValue(linksByEnvironmentAtom);
  const shell = useAtomValue(
    threadRef === null ? NO_SHELL_ATOM : environmentThreadShells.quietThreadShellAtom(threadRef),
  );
  if (threadRef === null) return null;
  const taskId = workTaskIdOfThread(
    links.get(threadRef.environmentId) ?? EMPTY_LINKS,
    shell,
    threadRef.threadId,
  );
  return taskId === null ? null : (views.get(workTaskKey(threadRef.environmentId, taskId)) ?? null);
}

/** True when the thread (or its subagent root) belongs to a Work Task. */
export function readThreadInWorkTask(threadRef: ScopedThreadRef): boolean {
  const links = appAtomRegistry.get(linksByEnvironmentAtom).get(threadRef.environmentId);
  const shell = appAtomRegistry.get(environmentThreadShells.quietThreadShellAtom(threadRef));
  return workTaskIdOfThread(links ?? EMPTY_LINKS, shell, threadRef.threadId) !== null;
}

const NO_SHELL_ATOM = Atom.make(null).pipe(Atom.withLabel("merge-work-task-no-shell"));

export function readWorkTaskView(key: string): WorkTaskView | null {
  return appAtomRegistry.get(workTaskViewsAtom).get(key) ?? null;
}

export function readLinkedWorkTasks(key: string): ReadonlyArray<EnvironmentWorkTask> {
  return appAtomRegistry.get(linkedWorkTasksAtom).get(key) ?? [];
}

/**
 * Used at the `thread-delete-worktree` seam: deleting a thread never removes a Work Task's
 * worktree. An environment whose stream failed (e.g. a server without Work Tasks) has none; one
 * still loading counts as owning everything.
 */
export function mergeWorkTaskOwnsWorktreePath(
  threadRef: ScopedThreadRef,
  worktreePath: string | null,
): boolean {
  if (worktreePath === null) return false;
  const result = appAtomRegistry.get(live({ environmentId: threadRef.environmentId, input: {} }));
  return workTaskOwnsWorktreePath(loadedWorkTasks(result), worktreePath);
}

/** Keeps every environment's Work Tasks stream open; mounted by the always-mounted dialogs host. */
export function useKeepWorkTasksLive(): void {
  useAtomValue(workTasksAtom);
}
