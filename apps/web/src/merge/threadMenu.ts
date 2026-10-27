import type { ContextMenuItem, ScopedThreadRef } from "@t3tools/contracts";

import type { ThreadActionMenuState } from "../components/threadActionMenu.logic";

export type MergeThreadMenuId = `merge:${string}`;

/** Fork thread context-menu entries. Spread into the menu at the `thread-menu` seam. */
export function mergeThreadMenuItems(
  _state: ThreadActionMenuState,
): ReadonlyArray<ContextMenuItem<MergeThreadMenuId>> {
  return [];
}

/** Returns true when the clicked id belongs to the fork and was handled. */
export function handleMergeThreadMenu(clicked: string, _threadRef: ScopedThreadRef): boolean {
  return clicked.startsWith("merge:");
}
