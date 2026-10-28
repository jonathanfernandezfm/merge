import { GitGraphIcon, ListTodoIcon } from "lucide-react";

import { useThreadRouteRef } from "~/hooks/useThreadRouteTarget";
import { GIT_GRAPH_SURFACE_ID, openMergeSurface } from "./gitGraph/surface";
import { WORK_ITEMS_SURFACE_ID } from "./workItems/state";

/** Fork entries for the right panel's surface launcher, spread at the `right-panel` seam. */
export function useMergeSurfaceActions() {
  const threadRef = useThreadRouteRef();
  const disabledReason = "Only available from a thread.";
  return [
    {
      label: "Git graph",
      icon: GitGraphIcon,
      shortcut: "G",
      available: threadRef !== null,
      disabledReason,
      onClick: () => {
        if (threadRef) openMergeSurface(threadRef, GIT_GRAPH_SURFACE_ID);
      },
    },
    {
      label: "Work items",
      icon: ListTodoIcon,
      shortcut: "W",
      available: threadRef !== null,
      disabledReason,
      onClick: () => {
        if (threadRef) openMergeSurface(threadRef, WORK_ITEMS_SURFACE_ID);
      },
    },
  ];
}
