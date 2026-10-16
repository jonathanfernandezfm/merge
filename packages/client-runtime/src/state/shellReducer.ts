import * as Arr from "effect/Array";
import type { OrchestrationShellSnapshot, OrchestrationShellStreamEvent } from "@t3tools/contracts";

/**
 * Reduce a single shell stream event into an existing snapshot, returning a new
 * snapshot with the event's changes applied. This is a pure reducer that both
 * web and mobile can use to keep their local shell snapshot in sync.
 *
 * Returns the original snapshot reference unchanged if the event is not
 * recognized (forward-compatible).
 */
export function applyShellStreamEvent(
  snapshot: OrchestrationShellSnapshot,
  event: OrchestrationShellStreamEvent,
): OrchestrationShellSnapshot {
  if (event.sequence <= snapshot.snapshotSequence) return snapshot;

  switch (event.kind) {
    case "project-upserted": {
      const projects = snapshot.projects.some((p) => p.id === event.project.id)
        ? Arr.map(snapshot.projects, (p) => (p.id === event.project.id ? event.project : p))
        : Arr.append(snapshot.projects, event.project);
      return { ...snapshot, projects, snapshotSequence: event.sequence };
    }
    case "project-removed":
      return {
        ...snapshot,
        projects: Arr.filter(snapshot.projects, (p) => p.id !== event.projectId),
        snapshotSequence: event.sequence,
      };
    case "thread-upserted": {
      const threads = snapshot.threads.some((t) => t.id === event.thread.id)
        ? Arr.map(snapshot.threads, (t) => (t.id === event.thread.id ? event.thread : t))
        : Arr.append(snapshot.threads, event.thread);
      return { ...snapshot, threads, snapshotSequence: event.sequence };
    }
    case "thread-removed":
      return {
        ...snapshot,
        threads: Arr.filter(snapshot.threads, (t) => t.id !== event.threadId),
        snapshotSequence: event.sequence,
      };
    case "task-upserted": {
      const current = snapshot.tasks ?? [];
      const tasks = current.some((t) => t.id === event.task.id)
        ? Arr.map(current, (t) => (t.id === event.task.id ? event.task : t))
        : Arr.append(current, event.task);
      return { ...snapshot, tasks, snapshotSequence: event.sequence };
    }
    case "task-removed":
      return {
        ...snapshot,
        tasks: Arr.filter(snapshot.tasks ?? [], (t) => t.id !== event.taskId),
        snapshotSequence: event.sequence,
      };
    case "folder-upserted": {
      const current = snapshot.folders ?? [];
      const folders = current.some((f) => f.id === event.folder.id)
        ? Arr.map(current, (f) => (f.id === event.folder.id ? event.folder : f))
        : Arr.append(current, event.folder);
      return { ...snapshot, folders, snapshotSequence: event.sequence };
    }
    // A removed folder releases its threads; the server sends no per-thread
    // upserts for them.
    case "folder-removed":
      return {
        ...snapshot,
        folders: Arr.filter(snapshot.folders ?? [], (f) => f.id !== event.folderId),
        threads: snapshot.threads.some((t) => t.folderId === event.folderId)
          ? Arr.map(snapshot.threads, (t) =>
              t.folderId === event.folderId ? { ...t, folderId: null } : t,
            )
          : snapshot.threads,
        snapshotSequence: event.sequence,
      };
    default:
      return snapshot;
  }
}
