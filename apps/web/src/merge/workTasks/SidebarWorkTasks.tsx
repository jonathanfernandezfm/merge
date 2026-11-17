import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId, WorkTaskId } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { ChevronDownIcon, ListFilterIcon, PlusIcon, SquareKanbanIcon } from "lucide-react";
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
import { cn } from "~/lib/utils";
import { useProjects } from "~/state/entities";
import { useOpenWorkTask, useWorkTaskContextMenu } from "./actions";
import { workTaskKey } from "./logic";
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
  const activeKey = useActiveWorkTaskKey();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const [storedExpanded, setExpanded] = useLocalStorage(EXPANDED_KEY, true, Schema.Boolean);
  const searching = searchQuery.trim().length > 0;
  // Matches would hide behind a collapsed section.
  const expanded = searching || storedExpanded;
  const [hiddenProjects, setHiddenProjects] = useLocalStorage(
    HIDDEN_PROJECTS_KEY,
    NO_HIDDEN_PROJECTS,
    HiddenProjectsSchema,
  );
  const hiddenProjectKeys = new Set(hiddenProjects);
  const setProjectHidden = (key: string, hidden: boolean) =>
    setHiddenProjects((value) =>
      hidden ? [...value.filter((entry) => entry !== key), key] : value.filter((e) => e !== key),
    );
  // Only projects that still exist count, so stale keys never keep the section alive.
  const hiddenCount = projects.filter((project) =>
    hiddenProjectKeys.has(`${project.environmentId}:${project.id}`),
  ).length;

  const query = searchQuery.trim().toLowerCase();
  // Search reaches hidden projects, so a match never disappears.
  const items = useWorkTaskItems().filter((item) =>
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

  const closeMobileSidebar = () => {
    if (isMobile) setOpenMobile(false);
  };
  const openWorkTask = useOpenWorkTask();
  const openContextMenu = useWorkTaskContextMenu(closeMobileSidebar);

  // Keep the header while projects are hidden; it holds the way back.
  if (items.length === 0 && (searching || hiddenCount === 0)) return null;

  return (
    <SidebarGroup className="shrink-0">
      <div className="group/work-tasks-header flex h-8 items-center gap-1 ps-2">
        <button
          type="button"
          aria-expanded={expanded}
          disabled={searching}
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left text-sm text-sidebar-muted-foreground/70 hover:text-sidebar-foreground"
        >
          <span className="shrink-0">Work Tasks</span>
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-3 shrink-0 opacity-0 transition-[opacity,transform] group-hover/work-tasks-header:opacity-100 group-focus-within/work-tasks-header:opacity-100",
              !expanded && "-rotate-90 opacity-100",
            )}
          />
        </button>
        <div className="flex shrink-0 items-center">
          <Menu>
            <MenuTrigger
              render={
                <SidebarHeaderIconButton
                  label={
                    hiddenCount > 0 ? `Filter and sort (${hiddenCount} hidden)` : "Filter and sort"
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
        </div>
      </div>
      {expanded && items.length === 0 ? (
        <p className="h-8 ps-2 pe-2 text-sm leading-8 text-sidebar-muted-foreground/70">
          All projects hidden
        </p>
      ) : expanded ? (
        <SidebarWorkTaskItems
          items={items}
          activeKey={activeKey}
          forceExpanded={searching}
          onOpen={(target) => {
            closeMobileSidebar();
            openWorkTask(target);
          }}
          onContextMenu={openContextMenu}
        />
      ) : null}
    </SidebarGroup>
  );
});
