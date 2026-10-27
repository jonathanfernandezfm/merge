import type { ContextMenuItem, ScopedThreadRef } from "@t3tools/contracts";

import type { ThreadActionMenuState } from "../components/threadActionMenu.logic";

export type MergeThreadMenuId = `merge:${string}`;

export interface MergeThreadMenuProvider {
  readonly items: (threadRef: ScopedThreadRef) => ReadonlyArray<ContextMenuItem<MergeThreadMenuId>>;
  /** True when the id was this provider's. */
  readonly handle: (clicked: MergeThreadMenuId, threadRef: ScopedThreadRef) => boolean;
}

// Features register from the fork's sidebar entry, so this file stays free of React and atom
// imports: upstream's menu logic and its tests import it.
const providers: MergeThreadMenuProvider[] = [];

export function registerMergeThreadMenu(provider: MergeThreadMenuProvider): void {
  if (!providers.includes(provider)) providers.push(provider);
}

/** Fork thread context-menu entries. Spread into the menu at the `thread-menu` seam. */
export function mergeThreadMenuItems(
  state: ThreadActionMenuState,
): ReadonlyArray<ContextMenuItem<MergeThreadMenuId>> {
  const threadRef = state.mergeThreadRef;
  return threadRef === undefined ? [] : providers.flatMap((provider) => provider.items(threadRef));
}

/** Returns true when the clicked id belongs to the fork and was handled. */
export function handleMergeThreadMenu(clicked: string, threadRef: ScopedThreadRef): boolean {
  if (!clicked.startsWith("merge:")) return false;
  const id = clicked as MergeThreadMenuId;
  providers.some((provider) => provider.handle(id, threadRef));
  return true;
}
