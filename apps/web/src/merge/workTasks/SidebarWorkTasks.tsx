import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId, WorkTaskId } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { ListFilterIcon, PlusIcon, SquareKanbanIcon } from "lucide-react";
import { memo } from "react";

import { SidebarHeaderIconButton } from "~/components/sidebar/SidebarThreadHeader";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuTrigger,
} from "~/components/ui/menu";
import { SidebarGroup, useSidebar } from "~/components/ui/sidebar";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useProjects } from "~/state/entities";
import { SidebarSectionTitle } from "../SidebarSectionTitle";
import { useOpenWorkTask, useWorkTaskContextMenu } from "./actions";
import { workTaskKey, type WorkTaskView } from "./logic";
import { SidebarWorkTaskItems } from "./SidebarWorkTaskItems";
import { useThreadWorkTask, useWorkTaskItems } from "./state";
import { openNewWorkTaskDialog } from "./WorkTaskDialogs";

const EXPANDED_KEY = "merge:work-tasks:expanded";
const HIDDEN_PROJECTS_KEY = "merge:work-tasks:projects-hidden";
const HiddenProjectsSchema = Schema.Array(Schema.String);
const NO_HIDDEN_PROJECTS: ReadonlyArray<string> = [];

/** The task the current route shows, from one of its threads or the Work Task page. */
function useActiveWorkTaskKey(): string | null {
  const params = useParams({
    strict: false,
    select: (value) => ({
      environmentId: value.environmentId as EnvironmentId | undefined,
      threadId: "threadId" in value ? (value.threadId as ThreadId | undefined) : undefined,
      taskId: "taskId" in value ? (value.taskId as WorkTaskId | undefined) : undefined,
    }),
  });
  const threadTask = useThreadWorkTask(
    params.environmentId && params.threadId
      ? scopeThreadRef(params.environmentId, params.threadId)
      : null,
  );
  if (!params.environmentId) return null;
  if (params.taskId) return workTaskKey(params.environmentId, params.taskId);
  return threadTask?.key ?? null;
}

/** Projects the header menu hides from Work Tasks; the Needs you lane honours them too. */
export function useHiddenWorkTaskProjects() {
  const [hiddenProjects, setHiddenProjects] = useLocalStorage(
    HIDDEN_PROJECTS_KEY,
    NO_HIDDEN_PROJECTS,
    HiddenProjectsSchema,
  );
  const setProjectHidden = (key: string, hidden: boolean) =>
    setHiddenProjects((value) =>
      hidden ? [...value.filter((entry) => entry !== key), key] : value.filter((e) => e !== key),
    );
  return { hiddenProjectKeys: new Set(hiddenProjects), setProjectHidden };
}

/** What a work task card needs to open and offer its menu, from the sidebar. */
export function useWorkTaskSidebarActions() {
  const { isMobile, setOpenMobile } = useSidebar();
  const closeMobileSidebar = () => {
    if (isMobile) setOpenMobile(false);
  };
  const openWorkTask = useOpenWorkTask();
  // Stable, so the memoized rows skip re-rendering when only the list around them changes.
  const onContextMenu = useStableCallback(useWorkTaskContextMenu(closeMobileSidebar));
  const onOpen = useStableCallback((target: WorkTaskView) => {
    closeMobileSidebar();
    openWorkTask(target);
  });
  return { activeKey: useActiveWorkTaskKey(), onOpen, onContextMenu, closeMobileSidebar };
}

/**
 * Work Tasks grouped by ADO item and sorted by who has the ball. The header menu hides
 * projects; search still reaches hidden projects. Renders nothing
 * when nothing is left to show; the Work Taskboard stays reachable from the command palette.
 */
export const SidebarWorkTasks = memo(function SidebarWorkTasks({
  searchQuery = "",
}: {
  searchQuery?: string;
}) {
  const projects = useProjects();
  const navigate = useNavigate();
  const { activeKey, onOpen, onContextMenu, closeMobileSidebar } = useWorkTaskSidebarActions();
  const [storedExpanded, setExpanded] = useLocalStorage(EXPANDED_KEY, true, Schema.Boolean);
  const searching = searchQuery.trim().length > 0;
  // Matches would hide behind a collapsed section.
  const expanded = searching || storedExpanded;
  const { hiddenProjectKeys, setProjectHidden } = useHiddenWorkTaskProjects();
  // Only projects that still exist count, so stale keys never keep the section alive.
  const hiddenCount = projects.filter((project) =>
    hiddenProjectKeys.has(`${project.environmentId}:${project.id}`),
  ).length;

  const query = searchQuery.trim().toLowerCase();
  // Search reaches hidden projects, so a match never disappears.
  const shown = useWorkTaskItems().filter((item) =>
    searching
      ? [
          item.title,
          item.workItem === null ? "" : String(item.workItem.id),
          ...item.members.flatMap((member) => [member.repo, member.view.task.workspace.branch]),
        ].some((text) => text.toLowerCase().includes(query))
      : item.members.some(
          ({ view }) => !hiddenProjectKeys.has(`${view.task.environmentId}:${view.task.projectId}`),
        ),
  );
  // Outside search, items that need you wait in the Needs you lane.
  const items = searching ? shown : shown.filter((item) => item.section !== "attention");

  // Keep the header while projects are hidden; it holds the way back.
  if (shown.length === 0 && (searching || hiddenCount === 0)) return null;

  return (
    <SidebarGroup className="shrink-0">
      <SidebarSectionTitle
        label="Work tasks"
        toggle={{
          expanded,
          disabled: searching,
          onToggle: () => setExpanded((value) => !value),
        }}
        actions={
          <>
            <Menu>
              <MenuTrigger
                render={
                  <SidebarHeaderIconButton
                    label={
                      hiddenCount > 0
                        ? `Filter and sort (${hiddenCount} hidden)`
                        : "Filter and sort"
                    }
                  />
                }
              >
                <ListFilterIcon />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuGroup>
                  <MenuGroupLabel>Show in Work Tasks</MenuGroupLabel>
                  {projects.map((project) => {
                    const key = `${project.environmentId}:${project.id}`;
                    return (
                      <MenuCheckboxItem
                        key={key}
                        checked={!hiddenProjectKeys.has(key)}
                        closeOnClick={false}
                        onCheckedChange={(checked) => setProjectHidden(key, !checked)}
                      >
                        <span className="block max-w-56 truncate">{project.title}</span>
                      </MenuCheckboxItem>
                    );
                  })}
                </MenuGroup>
              </MenuPopup>
            </Menu>
            <SidebarHeaderIconButton
              label="Work Taskboard"
              onClick={() => {
                closeMobileSidebar();
                void navigate({ to: "/work-tasks" });
              }}
            >
              <SquareKanbanIcon />
            </SidebarHeaderIconButton>
            <SidebarHeaderIconButton label="New Work Task" onClick={() => openNewWorkTaskDialog()}>
              <PlusIcon />
            </SidebarHeaderIconButton>
          </>
        }
      />
      {expanded && shown.length === 0 ? (
        <p className="h-8 px-(--sidebar-row-content-inset) text-sm leading-8 text-sidebar-muted-foreground/70">
          All projects hidden
        </p>
      ) : expanded ? (
        <SidebarWorkTaskItems
          items={items}
          activeKey={activeKey}
          forceExpanded={searching}
          onOpen={onOpen}
          onContextMenu={onContextMenu}
        />
      ) : null}
    </SidebarGroup>
  );
});
