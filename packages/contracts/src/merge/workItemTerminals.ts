/**
 * The work item a branch is named after: the first 4-7 digit run that stands alone between
 * separators, as in `feature/#123456-x` or `bugfix/ESP-123456`. Runs joined to other digits
 * (`2026-10-05`) or longer (`20240101`) are dates.
 */
export function workItemIdFromBranch(branch: string): number | null {
  const match = /(?:^|[/#_-])(?<!\d[_-])(\d{4,7})(?=$|[/_-])(?![_-]\d)/u.exec(branch);
  return match?.[1] === undefined ? null : Number(match[1]);
}

const WORK_ITEM_TERMINAL_PREFIX = "work-item:";

/** Terminal drawer key shared by every Work Task thread of one ADO work item. */
export const workItemTerminalThreadId = (workItemId: number): string =>
  `${WORK_ITEM_TERMINAL_PREFIX}${workItemId}`;

export const isWorkItemTerminalThreadId = (threadId: string): boolean =>
  threadId.startsWith(WORK_ITEM_TERMINAL_PREFIX);

/** True when `path` is `root` or lies under it; a trailing separator on `root` is ignored. */
export function isPathInside(path: string, root: string): boolean {
  const base = root.replace(/[/\\]+$/u, "");
  return path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}\\`);
}
