import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { ListTodoIcon } from "lucide-react";

import { useRightPanelStore } from "~/rightPanelStore";
import { useEnvironmentQuery } from "~/state/query";
import { sourceControlEnvironment } from "~/state/sourceControl";
import { Button } from "../ui/button";
import { MenuItem, MenuItemLabel } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Opens the Work items side panel from the chat header. Hidden until the
 * branch resolves to a work item, so threads without one keep a quiet header.
 */
export function WorkItemHeaderButton({
  environmentId,
  cwd,
  threadRef,
  presentation,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  threadRef: ScopedThreadRef;
  presentation: "toolbar" | "menu";
}) {
  const query = useEnvironmentQuery(
    sourceControlEnvironment.branchWorkItems({ environmentId, input: { cwd } }),
  );
  const root = query.data?.root ?? null;
  if (root === null) return null;
  const openPanel = () => useRightPanelStore.getState().open(threadRef, "work-items");

  if (presentation === "menu") {
    return (
      <MenuItem density="touch" onClick={openPanel}>
        <ListTodoIcon className="size-4" />
        <MenuItemLabel>Work item #{root.id}</MenuItemLabel>
      </MenuItem>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger render={<Button size="xs" variant="outline" onClick={openPanel} />}>
        <ListTodoIcon className="size-3.5" />
        <span className="font-mono tabular-nums">#{root.id}</span>
      </TooltipTrigger>
      <TooltipPopup>{root.title}</TooltipPopup>
    </Tooltip>
  );
}
