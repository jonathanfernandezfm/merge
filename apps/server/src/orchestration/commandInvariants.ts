import type {
  OrchestrationCommand,
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationTask,
  OrchestrationThread,
  ProjectId,
  TaskId,
  ThreadId,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Effect from "effect/Effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";

function invariantError(commandType: string, detail: string): OrchestrationCommandInvariantError {
  return new OrchestrationCommandInvariantError({
    commandType,
    detail,
  });
}

function findThreadById(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationThread | undefined {
  return readModel.threads.find((thread) => thread.id === threadId);
}

function findProjectById(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): OrchestrationProject | undefined {
  return readModel.projects.find((project) => project.id === projectId);
}

export function listThreadsByProjectId(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): ReadonlyArray<OrchestrationThread> {
  return readModel.threads.filter((thread) => thread.projectId === projectId);
}

export function requireProject(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<OrchestrationProject, OrchestrationCommandInvariantError> {
  const project = findProjectById(input.readModel, input.projectId);
  if (project) {
    return Effect.succeed(project);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireProjectAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findProjectById(input.readModel, input.projectId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireActiveProjectWorkspaceRootAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly workspaceRoot: string;
  readonly exceptProjectId?: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const normalizedWorkspaceRoot = normalizeProjectPathForComparison(input.workspaceRoot);
  const existingProject = input.readModel.projects.find(
    (project) =>
      project.deletedAt === null &&
      normalizeProjectPathForComparison(project.workspaceRoot) === normalizedWorkspaceRoot &&
      project.id !== input.exceptProjectId,
  );
  if (existingProject === undefined) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Active project '${existingProject.id}' already exists for workspace root '${normalizedWorkspaceRoot}'.`,
    ),
  );
}

export function requireThread(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  const thread = findThreadById(input.readModel, input.threadId);
  if (thread) {
    return Effect.succeed(thread);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireThreadArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.filterOrFail(
      (thread) => thread.archivedAt !== null,
      () =>
        invariantError(
          input.command.type,
          `Thread '${input.threadId}' is not archived for command '${input.command.type}'.`,
        ),
    ),
  );
}

export function requireThreadNotArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.filterOrFail(
      (thread) => thread.archivedAt === null,
      () =>
        invariantError(
          input.command.type,
          `Thread '${input.threadId}' is already archived and cannot handle command '${input.command.type}'.`,
        ),
    ),
  );
}

export function requireThreadAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  // Thread deletion is a soft delete and a draft keeps its client-minted id
  // across retries, so only a live row blocks creation. Projectors reset the
  // thread's rows when the id is created again.
  const existing = findThreadById(input.readModel, input.threadId);
  if (existing === undefined || existing.deletedAt !== null) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' already exists and cannot be created twice.`,
    ),
  );
}

function requireTask(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly taskId: TaskId;
}): Effect.Effect<OrchestrationTask, OrchestrationCommandInvariantError> {
  const task = input.readModel.tasks?.find((entry) => entry.id === input.taskId);
  if (task !== undefined && task.deletedAt === null) {
    return Effect.succeed(task);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Task '${input.taskId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireTaskNotArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly taskId: TaskId;
}): Effect.Effect<OrchestrationTask, OrchestrationCommandInvariantError> {
  return requireTask(input).pipe(
    Effect.filterOrFail(
      (task) => task.archivedAt === null,
      () =>
        invariantError(
          input.command.type,
          `Task '${input.taskId}' is archived and cannot handle command '${input.command.type}'.`,
        ),
    ),
  );
}

/**
 * A thread of an archived task has no worktree anymore: reviving it or starting
 * a turn would make the provider reactor recreate the worktree behind the task.
 */
export function requireThreadTaskNotArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly thread: OrchestrationThread;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const taskId = input.thread.taskId;
  if (taskId === undefined || taskId === null) return Effect.void;
  const task = input.readModel.tasks?.find((entry) => entry.id === taskId);
  if (task === undefined || task.archivedAt === null) return Effect.void;
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.thread.id}' belongs to archived task '${taskId}' and cannot handle command '${input.command.type}'.`,
    ),
  );
}

export function requireTaskAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly taskId: TaskId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (input.readModel.tasks?.some((entry) => entry.id === input.taskId) !== true) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Task '${input.taskId}' already exists and cannot be created twice.`,
    ),
  );
}
