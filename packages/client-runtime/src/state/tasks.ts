import {
  type EnvironmentId,
  type OrchestrationShellSnapshot,
  type OrchestrationTaskShell,
  type TaskId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { type UpdateTaskMetadataInput, updateTaskMetadata } from "../operations/commands.ts";
import { type EnvironmentCatalogState, enabledEnvironmentIds } from "./connections.ts";
import { arrayElementsEqual } from "./entities.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
} from "./runtime.ts";

export type { UpdateTaskMetadataInput } from "../operations/commands.ts";

export interface EnvironmentTask extends OrchestrationTaskShell {
  readonly environmentId: EnvironmentId;
}

export interface ScopedTaskRef {
  readonly environmentId: EnvironmentId;
  readonly taskId: TaskId;
}

export function scopedTaskKey(ref: ScopedTaskRef): string {
  return `${ref.environmentId}\u0000${ref.taskId}`;
}

const EMPTY_TASKS: ReadonlyArray<OrchestrationTaskShell> = Object.freeze([]);
const EMPTY_TASK_INDEX: ReadonlyMap<TaskId, OrchestrationTaskShell> = new Map();

/** Task shells from each environment's shell snapshot, scoped like projects. */
export function createEnvironmentTaskAtoms(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly snapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationShellSnapshot | null>;
}) {
  // One scoped object per source task, shared by point reads and lists, so
  // unchanged tasks keep their identity across snapshot updates.
  const scopedTasks = new WeakMap<OrchestrationTaskShell, EnvironmentTask>();
  const scopeTask = (environmentId: EnvironmentId, task: OrchestrationTaskShell) => {
    let value = scopedTasks.get(task);
    if (value === undefined) {
      value = { ...task, environmentId };
      scopedTasks.set(task, value);
    }
    return value;
  };

  const environmentTasksAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): ReadonlyArray<OrchestrationTaskShell> =>
        get(input.snapshotAtom(environmentId))?.tasks ?? EMPTY_TASKS,
    ).pipe(Atom.withLabel(`environment-tasks:${environmentId}`)),
  );

  const environmentTaskIndexAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): ReadonlyMap<TaskId, OrchestrationTaskShell> => {
      const tasks = get(environmentTasksAtom(environmentId));
      if (tasks.length === 0) return EMPTY_TASK_INDEX;
      return new Map(tasks.map((task) => [task.id, task] as const));
    }).pipe(Atom.withLabel(`environment-task-index:${environmentId}`)),
  );

  const taskAtomFamily = Atom.family((key: string) => {
    const separator = key.indexOf("\u0000");
    const environmentId = key.slice(0, separator) as EnvironmentId;
    const taskId = key.slice(separator + 1) as TaskId;
    return Atom.make((get) => {
      const source = get(environmentTaskIndexAtom(environmentId)).get(taskId) ?? null;
      return source === null ? null : scopeTask(environmentId, source);
    }).pipe(Atom.withLabel(`environment-task:${key}`));
  });

  // Every task in every enabled environment, archived ones included: the
  // sidebar hides them, the Taskboard keeps their history reachable.
  let previousTasks: ReadonlyArray<EnvironmentTask> = [];
  const tasksAtom = Atom.make((get) => {
    const next: EnvironmentTask[] = [];
    for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
      for (const task of get(environmentTasksAtom(environmentId))) {
        if (task.deletedAt !== null) continue;
        next.push(scopeTask(environmentId, task));
      }
    }
    if (arrayElementsEqual(previousTasks, next)) return previousTasks;
    previousTasks = next;
    return previousTasks;
  }).pipe(Atom.withLabel("environment-task-list"));

  return {
    environmentTasksAtom,
    tasksAtom,
    taskAtom: (ref: ScopedTaskRef) => taskAtomFamily(scopedTaskKey(ref)),
  };
}

/** Task RPCs and the user-owned `task.meta.update` command. */
export function createTaskEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const taskConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { taskId: string } }) =>
      JSON.stringify([environmentId, input.taskId]),
  };
  return {
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tasks:create",
      tag: WS_METHODS.taskCreate,
      scheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    retrySetup: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tasks:retry-setup",
      tag: WS_METHODS.taskRetrySetup,
      scheduler,
      concurrency: taskConcurrency,
    }),
    archiveCheck: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tasks:archive-check",
      tag: WS_METHODS.taskArchiveCheck,
    }),
    archive: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tasks:archive",
      tag: WS_METHODS.taskArchive,
      scheduler,
      concurrency: taskConcurrency,
    }),
    createThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tasks:create-thread",
      tag: WS_METHODS.taskCreateThread,
      scheduler,
      concurrency: taskConcurrency,
    }),
    updateMetadata: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:task:update",
      execute: (input: UpdateTaskMetadataInput) => updateTaskMetadata(input),
      scheduler,
      concurrency: taskConcurrency,
    }),
  };
}

export * from "./taskThreads.ts";
