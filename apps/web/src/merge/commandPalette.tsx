import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { GitGraphIcon } from "lucide-react";

import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "~/components/CommandPalette.logic";
import { GIT_GRAPH_SURFACE_ID, openMergeSurface } from "./gitGraph/surface";

/** Fork actions for the command palette, appended at the `command-palette` seam. */
export function mergeCommandPaletteActions(
  thread: { readonly environmentId: EnvironmentId; readonly id: ThreadId } | null | undefined,
): CommandPaletteActionItem[] {
  if (!thread) return [];
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  return [
    {
      kind: "action",
      value: "action:open-git-graph",
      searchTerms: ["git graph", "commits", "history", "log", "compare branch"],
      title: "Open Git graph",
      icon: <GitGraphIcon className={ITEM_ICON_CLASS} />,
      run: async () => openMergeSurface(threadRef, GIT_GRAPH_SURFACE_ID),
    },
  ];
}
