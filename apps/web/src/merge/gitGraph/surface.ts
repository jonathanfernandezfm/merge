import type { ScopedThreadRef } from "@t3tools/contracts";

import { useRightPanelStore } from "~/rightPanelStore";

export const GIT_GRAPH_SURFACE_ID = "merge:git-graph" as const;

/**
 * Opens a fork surface in the thread's right panel. The store has no fork-aware open action, so
 * this goes through `openProactive`, which accepts any surface and refuses only when the user
 * acted after the revision read here.
 */
export function openMergeSurface(ref: ScopedThreadRef, id: `merge:${string}`): void {
  const panels = useRightPanelStore.getState();
  panels.openProactive(
    ref,
    { id, kind: "merge" } as never,
    panels.getUserActionRevision(ref),
    true,
  );
}
