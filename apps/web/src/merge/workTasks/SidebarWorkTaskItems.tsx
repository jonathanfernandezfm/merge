import { selectRunningSubprocessTerminalIds } from "@t3tools/client-runtime/state/terminal";
import * as Schema from "effect/Schema";
import { TerminalIcon } from "lucide-react";
import { memo, type MouseEvent } from "react";

import { SidebarSectionHeader } from "~/components/sidebar/SidebarListMarkers";
import { terminalStatusFromRunningIds } from "~/components/ThreadStatusIndicators";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { useProjects } from "~/state/entities";
import { useKnownTerminalSessions } from "~/state/terminalSessions";
import type { WorkTaskItem } from "./grouping";
import type { WorkTaskView } from "./logic";
import { TONE_CLASS, UNSEEN_RESPONSE_PRESENTATION, WorkTaskStatusIcon } from "./presentation";
import { useLinkedWorkTasks } from "./state";
import { WORK_TASK_STATUS_PRESENTATION } from "./statusPresentation";

const SHELVES_KEY = "merge:work-task-shelves:v1";
const ShelvesSchema = Schema.Struct({
  working: Schema.Boolean,
  review: Schema.Boolean,
  done: Schema.Boolean,
});
const DEFAULT_SHELVES = { working: true, review: true, done: false };

// SidebarSectionHeader only offers the Threads list's marker ids; the ids only name the header.
const SHELVES = [
  { section: "working", label: "Working", marker: "working-header" },
  { section: "review", label: "In review", marker: "snoozed-header" },
  { section: "done", label: "Done", marker: "settled-header" },
] as const;

/** Items needing you first with no header, then the Working, In review and Done shelves. */
export function SidebarWorkTaskItems({
  items,
  activeKey,
  forceExpanded,
  onOpen,
  onContextMenu,
}: {
  items: ReadonlyArray<WorkTaskItem>;
  activeKey: string | null;
  /** Matches would hide behind a collapsed shelf. */
  forceExpanded: boolean;
  onOpen: (view: WorkTaskView) => void;
  onContextMenu: (view: WorkTaskView, position: { x: number; y: number }) => void;
}) {
  const [shelves, setShelves] = useLocalStorage(SHELVES_KEY, DEFAULT_SHELVES, ShelvesSchema);
  const row = (item: WorkTaskItem) => (
    <SidebarWorkTaskItemRow
      key={item.key}
      item={item}
      active={item.members.some((member) => member.view.key === activeKey)}
      onOpen={onOpen}
      onContextMenu={onContextMenu}
    />
  );
  return (
    <ul className="flex flex-col gap-px pb-2">
      {items.filter((item) => item.section === "attention").map(row)}
      {SHELVES.map(({ section, label, marker }) => {
        const shelf = items.filter((item) => item.section === section);
        if (shelf.length === 0) return null;
        const expanded = forceExpanded || shelves[section];
        return (
          <li key={section} className="list-none">
            <ul className="flex flex-col gap-px">
              <SidebarSectionHeader
                marker={marker}
                label={label}
                count={shelf.length}
                toggle={{
                  expanded,
                  onToggle: () => setShelves((value) => ({ ...value, [section]: !value[section] })),
                }}
              />
              {expanded ? shelf.map(row) : null}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}

const SidebarWorkTaskItemRow = memo(function SidebarWorkTaskItemRow({
  item,
  active,
  onOpen,
  onContextMenu,
}: {
  item: WorkTaskItem;
  active: boolean;
  onOpen: (view: WorkTaskView) => void;
  onContextMenu: (view: WorkTaskView, position: { x: number; y: number }) => void;
}) {
  const projects = useProjects();
  const linkedByKey = useLinkedWorkTasks();
  // The task a click opens: the one touched last.
  const latest = item.members.reduce((best, member) =>
    member.view.activityAt > best.view.activityAt ? member : best,
  ).view;
  const { task, tabs } = latest;
  // A process running in any of the task's thread terminals, e.g. a Run script.
  const terminalSessions = useKnownTerminalSessions({
    environmentId: task.environmentId,
    threadId: null,
  });
  const threadIds = new Set<string>(tabs.map(({ shell }) => shell.id));
  const terminalStatus = terminalStatusFromRunningIds(
    selectRunningSubprocessTerminalIds(
      (terminalSessions ?? []).filter((session) => threadIds.has(session.target.threadId)),
    ),
  );
  const linkedProjects = linkedByKey
    .get(latest.key)
    ?.map(
      (sibling) =>
        projects.find(
          (project) =>
            project.environmentId === sibling.environmentId && project.id === sibling.projectId,
        )?.title ?? sibling.title,
    )
    .join(", ");
  const status = WORK_TASK_STATUS_PRESENTATION[latest.status];
  const detail = [
    item.unseen ? UNSEEN_RESPONSE_PRESENTATION.label : null,
    status.label,
    terminalStatus?.label ?? null,
    task.workspace.branch,
    latest.pullRequest !== null ? `#${latest.pullRequest.number}` : null,
    linkedProjects !== undefined ? `Also in ${linkedProjects}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const single = item.members.length === 1 ? item.members[0]! : null;
  return (
    <li>
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        aria-label={`${item.title}, ${detail}`}
        onClick={() => onOpen(latest)}
        onContextMenu={(event: MouseEvent) => {
          event.preventDefault();
          onContextMenu(latest, { x: event.clientX, y: event.clientY });
        }}
        className={cn(
          "flex w-full min-w-0 cursor-pointer flex-col gap-0.5 rounded-md py-1 ps-8 pe-2 text-left",
          active
            ? "bg-primary/8 text-sidebar-foreground"
            : "text-sidebar-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
          item.unseen && "text-sidebar-foreground",
        )}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          {item.unseen ? (
            <UNSEEN_RESPONSE_PRESENTATION.Icon className={UNSEEN_RESPONSE_PRESENTATION.className} />
          ) : (
            <WorkTaskStatusIcon status={item.status} />
          )}
          <span className={cn("min-w-0 flex-1 truncate text-sm", item.unseen && "font-semibold")}>
            {item.title}
          </span>
          {terminalStatus ? (
            <TerminalIcon
              aria-hidden
              className={cn("size-3.5 shrink-0", terminalStatus.colorClass)}
            />
          ) : null}
        </span>
        <span className="block truncate ps-6 text-xs text-sidebar-muted-foreground">
          {single !== null ? (
            <>
              {single.repo}
              {" · "}
              <span
                className={
                  item.unseen ? UNSEEN_RESPONSE_PRESENTATION.className : TONE_CLASS[status.tone]
                }
              >
                {item.unseen ? UNSEEN_RESPONSE_PRESENTATION.label : status.label}
              </span>
            </>
          ) : (
            item.members.map((member) => (
              <span key={member.view.key} className="me-2 inline-flex items-center gap-1">
                <WorkTaskStatusIcon status={member.view.status} />
                {member.label}
              </span>
            ))
          )}
        </span>
      </button>
    </li>
  );
});
