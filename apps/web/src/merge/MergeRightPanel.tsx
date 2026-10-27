import type { ScopedThreadRef } from "@t3tools/contracts";

import type { DraftId } from "~/composerDraftStore";
import { GitGraphPanel } from "./gitGraph/GitGraphPanel";
import { GIT_GRAPH_SURFACE_ID } from "./gitGraph/surface";
import { WORK_ITEMS_SURFACE_ID } from "./workItems/state";
import { WorkItemsPanel } from "./workItems/WorkItemsPanel";

/** Body of a `{ kind: "merge" }` right-panel surface. */
export function MergeRightPanel(props: {
  readonly id: string;
  readonly threadRef: ScopedThreadRef;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  readonly workspaceMutationId: string | null;
  readonly workspaceRoot: string | undefined;
}) {
  if (props.id === GIT_GRAPH_SURFACE_ID) {
    if (!props.workspaceRoot) {
      return (
        <p className="px-4 py-6 text-center text-xs text-muted-foreground">
          The Git graph needs a project workspace. Open a thread in a project to use it.
        </p>
      );
    }
    return (
      <GitGraphPanel
        key={`${props.threadRef.environmentId}:${props.threadRef.threadId}`}
        threadRef={props.threadRef}
        cwd={props.workspaceRoot}
        composerDraftTarget={props.composerDraftTarget}
        workspaceMutationId={props.workspaceMutationId}
      />
    );
  }
  if (props.id === WORK_ITEMS_SURFACE_ID) {
    if (!props.workspaceRoot) {
      return (
        <p className="px-4 py-6 text-center text-xs text-muted-foreground">
          Work items need a project workspace. Open a thread in a project to use them.
        </p>
      );
    }
    return (
      <WorkItemsPanel environmentId={props.threadRef.environmentId} cwd={props.workspaceRoot} />
    );
  }
  return null;
}
