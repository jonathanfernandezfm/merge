import { GitGraphIcon, ListTodoIcon } from "lucide-react";

import { GIT_GRAPH_SURFACE_ID } from "./gitGraph/surface";
import { WORK_ITEMS_SURFACE_ID } from "./workItems/state";

// Apart from MergeRightPanel so the tab strip does not load the panels (and their diff worker).
/** Tab label of a `{ kind: "merge" }` right-panel surface. */
export function mergeRightPanelLabel(id: string): string {
  if (id === GIT_GRAPH_SURFACE_ID) return "Git graph";
  if (id === WORK_ITEMS_SURFACE_ID) return "Work items";
  return id;
}

/** Tab icon of a `{ kind: "merge" }` right-panel surface. */
export function MergeRightPanelIcon({ id }: { id: string }) {
  if (id === GIT_GRAPH_SURFACE_ID) return <GitGraphIcon className="size-3 shrink-0" />;
  if (id === WORK_ITEMS_SURFACE_ID) return <ListTodoIcon className="size-3 shrink-0" />;
  return null;
}
