import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentTaskAtoms,
  createTaskEnvironmentAtoms,
  taskThreadsInOrder,
  type EnvironmentTask,
  type ScopedTaskRef,
} from "@t3tools/client-runtime/state/tasks";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { arrayElementsEqual } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentId, TaskId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";
import { environmentThreadShells } from "./threads";

export const taskEnvironment = createTaskEnvironmentAtoms(connectionAtomRuntime);
const environmentTasks = createEnvironmentTaskAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
});

const EMPTY_TASK_ATOM = Atom.make<EnvironmentTask | null>(null).pipe(
  Atom.withLabel("web-task:empty"),
);
const EMPTY_THREADS: ReadonlyArray<EnvironmentThreadShell> = Object.freeze([]);
const EMPTY_TASK_THREADS_ATOM = Atom.make(EMPTY_THREADS).pipe(
  Atom.withLabel("web-task-threads:empty"),
);

/**
 * Every task thread grouped by task, so a task row or tab bar re-renders
 * only when its own threads change, not on every unrelated thread update.
 */
const taskThreadsByTaskAtom = (() => {
  let previous: ReadonlyMap<string, ReadonlyArray<EnvironmentThreadShell>> = new Map();
  return Atom.make((get) => {
    const grouped = new Map<string, EnvironmentThreadShell[]>();
    for (const thread of get(environmentThreadShells.threadShellsAtom)) {
      if (thread.taskId == null) continue;
      const key = `${thread.environmentId}\u0000${thread.taskId}`;
      const list = grouped.get(key);
      if (list === undefined) grouped.set(key, [thread]);
      else list.push(thread);
    }
    const next = new Map<string, ReadonlyArray<EnvironmentThreadShell>>();
    for (const [key, threads] of grouped) {
      const before = previous.get(key);
      next.set(key, before !== undefined && arrayElementsEqual(before, threads) ? before : threads);
    }
    previous = next;
    return next;
  }).pipe(Atom.withLabel("web-task-threads-by-task"));
})();

/** A task's live threads in tab order; a new array only when they change. */
const taskThreadsAtomFamily = Atom.family((key: string) => {
  const taskId = key.slice(key.indexOf("\u0000") + 1) as TaskId;
  let previous: ReadonlyArray<EnvironmentThreadShell> = EMPTY_THREADS;
  return Atom.make((get) => {
    const next = taskThreadsInOrder(get(taskThreadsByTaskAtom).get(key) ?? EMPTY_THREADS, taskId);
    if (arrayElementsEqual(previous, next)) return previous;
    previous = next;
    return previous;
  }).pipe(Atom.withLabel(`web-task-threads:${key}`));
});

function taskRefKey(ref: ScopedTaskRef): string {
  return `${ref.environmentId}\u0000${ref.taskId}`;
}

/** Every task across enabled environments, archived ones included. */
export function useTasks(): ReadonlyArray<EnvironmentTask> {
  return useAtomValue(environmentTasks.tasksAtom);
}

export function useTask(
  environmentId: EnvironmentId | null,
  taskId: TaskId | null | undefined,
): EnvironmentTask | null {
  return useAtomValue(
    environmentId === null || taskId == null
      ? EMPTY_TASK_ATOM
      : environmentTasks.taskAtom({ environmentId, taskId }),
  );
}

/** A task's live (non-archived) threads in creation order: its tabs. */
export function useTaskThreadShells(
  ref: ScopedTaskRef | null,
): ReadonlyArray<EnvironmentThreadShell> {
  return useAtomValue(
    ref === null ? EMPTY_TASK_THREADS_ATOM : taskThreadsAtomFamily(taskRefKey(ref)),
  );
}

/** Every task thread across environments, keyed by `${environmentId}\0${taskId}`. */
export function useTaskThreadsByTask(): ReadonlyMap<string, ReadonlyArray<EnvironmentThreadShell>> {
  return useAtomValue(taskThreadsByTaskAtom);
}

export function taskThreadsKey(environmentId: EnvironmentId, taskId: TaskId): string {
  return taskRefKey({ environmentId, taskId });
}
