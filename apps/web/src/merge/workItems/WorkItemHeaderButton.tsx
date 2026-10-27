import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ListTodoIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useProject, useThreadShell } from "~/state/entities";
import { openMergeSurface } from "../gitGraph/surface";
import { WORK_ITEMS_SURFACE_ID } from "./state";
import { useBranchWorkItems } from "./workItemPresentation";

/** Only server threads in a real project have a checkout to read a branch from. */
export function WorkItemsChip(props: { thread: ScopedThreadRef }) {
  const shell = useThreadShell(props.thread);
  const project = useProject(
    shell ? scopeProjectRef(props.thread.environmentId, shell.projectId) : null,
  );
  const cwd = shell?.worktreePath ?? (project?.isScratch ? null : project?.workspaceRoot);
  if (!cwd) return null;
  return <BranchWorkItemButton threadRef={props.thread} cwd={cwd} />;
}

/**
 * Opens the Work items panel from the chat header. Hidden until the branch resolves to a work
 * item, so threads without one keep a quiet header. Rendered at the `work-items` seam.
 */
function BranchWorkItemButton(props: { threadRef: ScopedThreadRef; cwd: string }) {
  const query = useBranchWorkItems(props.threadRef.environmentId, props.cwd);
  const root = query.data?.root ?? null;
  if (root === null) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="xs"
            variant="outline"
            className="shrink-0"
            onClick={() => openMergeSurface(props.threadRef, WORK_ITEMS_SURFACE_ID)}
          />
        }
      >
        <ListTodoIcon className="size-3.5" />
        <span className="font-mono tabular-nums">#{root.id}</span>
      </TooltipTrigger>
      <TooltipPopup>{root.title}</TooltipPopup>
    </Tooltip>
  );
}
