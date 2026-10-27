import type { ScopedThreadRef } from "@t3tools/contracts";

import type { DraftId } from "~/composerDraftStore";
import { GitGraphPanel } from "./gitGraph/GitGraphPanel";
import { GIT_GRAPH_SURFACE_ID } from "./gitGraph/surface";

/** Body of a `{ kind: "merge" }` right-panel surface. */
export function MergeRightPanel(props: {
  readonly id: string;
  readonly threadRef: ScopedThreadRef;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  readonly workspaceMutationId: string | null;
  readonly workspaceRoot: string | undefined;
}) {
  if (props.id === GIT_GRAPH_SURFACE_ID && props.workspaceRoot) {
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
  return null;
}

/** Tab label of a `{ kind: "merge" }` right-panel surface. */
export function mergeRightPanelLabel(id: string): string {
  return id === GIT_GRAPH_SURFACE_ID ? "Git graph" : id;
}
