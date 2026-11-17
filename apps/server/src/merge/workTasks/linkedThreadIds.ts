/**
 * Threads linked to a Work Task that is not deleted, archived ones included. Held in memory so
 * the settlement sweep and the shell trims (seams `settle-skip-work-tasks`,
 * `shell-keep-work-task-threads`) read it without a query. `WorkTaskStore` refreshes it at
 * startup and after every link write.
 */
let ids: ReadonlySet<string> = new Set();

export const mergeWorkTaskThreadIds: { has(id: string): boolean } = {
  has: (id) => ids.has(id),
};

export function setMergeWorkTaskThreadIds(next: Iterable<string>): void {
  ids = new Set(next);
}
