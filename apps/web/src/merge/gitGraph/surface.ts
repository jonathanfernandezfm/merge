import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useRightPanelStore } from "~/rightPanelStore";

export const GIT_GRAPH_SURFACE_ID = "merge:git-graph" as const;

type OpenProactiveRequest = Parameters<
  ReturnType<typeof useRightPanelStore.getState>["openProactive"]
>[1];

/**
 * Opens a fork surface in the thread's right panel. The store has no fork-aware open action, so
 * this goes through `openProactive` (which accepts any surface), then counts as a user action
 * like upstream's user-initiated opens, so a later automatic open does not take the panel over.
 */
export function openMergeSurface(ref: ScopedThreadRef, id: `merge:${string}`): void {
  const panels = useRightPanelStore.getState();
  const request = { id, kind: "merge" } as unknown as OpenProactiveRequest;
  panels.openProactive(ref, request, panels.getUserActionRevision(ref), true);
  const threadKey = scopedThreadKey(ref);
  useRightPanelStore.setState((state) => ({
    userActionRevisionByThreadKey: {
      ...state.userActionRevisionByThreadKey,
      [threadKey]: (state.userActionRevisionByThreadKey[threadKey] ?? 0) + 1,
    },
  }));
}
