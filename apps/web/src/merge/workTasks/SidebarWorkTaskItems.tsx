import { workItemIdFromBranch, workItemTerminalThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { memo, type MouseEvent } from "react";

import { SidebarSectionHeader } from "~/components/sidebar/SidebarListMarkers";
import { ProjectMonogram } from "~/components/ProjectMonogram";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { deriveProjectIdentity } from "~/projectIdentity";
import { useProjects } from "~/state/entities";
import { useKnownTerminalSessions } from "~/state/terminalSessions";
import type { WorkTaskItem, WorkTaskItemMember } from "./grouping";
import { latestWorkTaskMember, type WorkTaskView } from "./logic";
import { TONE_CLASS, UNSEEN_RESPONSE_PRESENTATION, WorkTaskStatusIcon } from "./presentation";
import { runningItemMemberCommands } from "./workItemDrawer";
import { WorkTaskHoverCard } from "./WorkTaskHoverCard";
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

/**
 * Items needing you first with no header, then the Working, In review and Done shelves. Outside
 * search the Needs you lane holds the first group, so it arrives here empty.
 */
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
  onContextMenu: (item: WorkTaskItem, position: { x: number; y: number }) => void;
}) {
  const [shelves, setShelves] = useLocalStorage(SHELVES_KEY, DEFAULT_SHELVES, ShelvesSchema);
  const row = useWorkTaskRowRenderer({ activeKey, onOpen, onContextMenu });
  return (
    <ul className="flex flex-col gap-1.5 pb-2">
      {items.filter((item) => item.section === "attention").map(row)}
      {SHELVES.map(({ section, label, marker }) => {
        const shelf = items.filter((item) => item.section === section);
        if (shelf.length === 0) return null;
        const expanded = forceExpanded || shelves[section];
        return (
          <li key={section} className="list-none">
            <ul className="flex flex-col gap-1.5">
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

/** Draws one item's card; the Work tasks section and the Needs you lane share it. */
export function useWorkTaskRowRenderer({
  activeKey,
  onOpen,
  onContextMenu,
}: {
  activeKey: string | null;
  onOpen: (view: WorkTaskView) => void;
  onContextMenu: (item: WorkTaskItem, position: { x: number; y: number }) => void;
}) {
  // Read once per list, not per row, so a project or link change does not wake every row.
  const projects = useProjects();
  const linkedByKey = useLinkedWorkTasks();
  const linkedProjectsOf = (key: string) =>
    linkedByKey
      .get(key)
      ?.map(
        (sibling) =>
          projects.find(
            (project) =>
              project.environmentId === sibling.environmentId && project.id === sibling.projectId,
          )?.title ?? sibling.title,
      )
      .join(", ");
  return (item: WorkTaskItem) => (
    <SidebarWorkTaskItemRow
      key={item.key}
      item={item}
      linkedProjects={linkedProjectsOf(leadMember(item).view.key)}
      // Null unless this item holds the active task, so other rows skip re-rendering.
      activeKey={item.members.some((member) => member.view.key === activeKey) ? activeKey : null}
      onOpen={onOpen}
      onContextMenu={onContextMenu}
    />
  );
}

/** The member that decides the glyph and status; the label describes the same one. */
const leadMember = (item: WorkTaskItem) =>
  item.members.find(
    (member) => member.view.status === item.status && member.unseen === item.unseen,
  ) ?? item.members[0]!;

const SidebarWorkTaskItemRow = memo(function SidebarWorkTaskItemRow({
  item,
  linkedProjects,
  activeKey,
  onOpen,
  onContextMenu,
}: {
  item: WorkTaskItem;
  /** Titles of the projects the shown task is also in. */
  linkedProjects: string | undefined;
  activeKey: string | null;
  onOpen: (view: WorkTaskView) => void;
  onContextMenu: (item: WorkTaskItem, position: { x: number; y: number }) => void;
}) {
  const lead = leadMember(item);
  // The task a click opens: the one touched last.
  const latest = latestWorkTaskMember(item).view;
  const shown = lead.view;
  const { task } = shown;
  // A process running in any of the task's thread terminals, e.g. a Run script.
  const terminalSessions = useKnownTerminalSessions({
    environmentId: task.environmentId,
    threadId: null,
  });
  const itemId = workItemIdFromBranch(task.workspace.branch);
  const runningCommands = runningItemMemberCommands(
    terminalSessions ?? [],
    itemId === null ? null : workItemTerminalThreadId(itemId),
    item.members.map(({ view }) => ({
      key: view.key,
      path: view.task.workspace.path,
      threadIds: view.tabs.map(({ shell }) => shell.id),
    })),
  );
  const status = WORK_TASK_STATUS_PRESENTATION[shown.status];
  const detail = [
    item.unseen ? UNSEEN_RESPONSE_PRESENTATION.label : null,
    status.label,
    ...[...runningCommands.values()].map((command) => `Running ${command}`),
    task.workspace.branch,
    shown.pullRequest !== null ? `#${shown.pullRequest.number}` : null,
    linkedProjects !== undefined ? `Also in ${linkedProjects}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const single = item.members.length === 1 ? item.members[0]! : null;
  const active = activeKey !== null;
  const openMenu = (event: MouseEvent) => {
    event.preventDefault();
    onContextMenu(item, { x: event.clientX, y: event.clientY });
  };
  return (
    // A card per task, so tasks and their repo rows read as one unit.
    <li
      className={cn(
        "overflow-hidden rounded-lg border transition-colors",
        active
          ? "border-sidebar-foreground/15 bg-sidebar-row-active/60"
          : "border-sidebar-border bg-sidebar-row-hover/25 hover:border-sidebar-foreground/12",
      )}
    >
      <WorkTaskHoverCard item={item} onOpen={onOpen}>
        <button
          type="button"
          aria-current={active && single !== null ? "page" : undefined}
          aria-label={`${item.title}, ${detail}`}
          onClick={() => onOpen(latest)}
          onContextMenu={openMenu}
          className={cn(
            ROW_CLASS,
            "flex-col gap-1 py-2",
            single !== null && active ? ACTIVE_CLASS : IDLE_CLASS,
            item.unseen && "text-sidebar-foreground",
          )}
        >
          <span className="flex w-full min-w-0 items-center gap-2.5">
            {item.unseen ? (
              <UNSEEN_RESPONSE_PRESENTATION.Icon
                className={UNSEEN_RESPONSE_PRESENTATION.className}
              />
            ) : (
              <WorkTaskStatusIcon status={item.status} />
            )}
            <span className={cn("min-w-0 flex-1 truncate text-sm", item.unseen && "font-semibold")}>
              {item.title}
            </span>
          </span>
          {single !== null ? (
            <RepoLine
              member={single}
              command={runningCommands.get(single.view.key) ?? null}
              className="ps-6"
            />
          ) : null}
        </button>
      </WorkTaskHoverCard>
      {single === null ? (
        <ul
          aria-label={`${item.title} repositories`}
          className="flex flex-col gap-px border-t border-sidebar-border/70 py-1"
        >
          {item.members.map((member) => (
            <WorkTaskMemberRow
              key={member.view.key}
              member={member}
              active={member.view.key === activeKey}
              command={runningCommands.get(member.view.key) ?? null}
              onOpen={onOpen}
              onContextMenu={openMenu}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
});

const ROW_CLASS =
  "flex w-full min-w-0 cursor-pointer px-(--sidebar-row-content-inset) text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
const ACTIVE_CLASS = "text-sidebar-foreground";
const IDLE_CLASS =
  "text-sidebar-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground";

/** `[badge] repo · Status`, then the command running in that repo, if any. */
function RepoLine({
  member,
  command,
  className,
}: {
  member: WorkTaskItemMember;
  command: string | null;
  className?: string;
}) {
  const { view, unseen } = member;
  const status = WORK_TASK_STATUS_PRESENTATION[view.status];
  const identity = deriveProjectIdentity(member.repo);
  return (
    <span className={cn("flex w-full min-w-0 items-center gap-1.5 text-xs", className)}>
      <ProjectMonogram text={identity.monogram} color={identity.color} className="size-3.5" />
      <span
        className={cn("min-w-0 truncate text-sidebar-foreground/80", unseen && "font-semibold")}
      >
        {member.label}
      </span>
      <span aria-hidden className="text-sidebar-muted-foreground/60">
        ·
      </span>
      <span
        className={cn(
          "shrink-0",
          unseen ? UNSEEN_RESPONSE_PRESENTATION.className : TONE_CLASS[status.tone],
        )}
      >
        {unseen ? UNSEEN_RESPONSE_PRESENTATION.label : status.label}
      </span>
      {command !== null ? <RunningCommandChip command={command} /> : null}
    </span>
  );
}

/** A live process in the task's environment, named by its command (e.g. `bun dev`). */
function RunningCommandChip({ command }: { command: string }) {
  return (
    <span className="ms-auto flex min-w-0 max-w-[55%] items-center gap-1 rounded-md bg-info/10 px-1.5 py-px font-mono text-2xs text-info-foreground">
      <span aria-hidden className="relative flex size-1.5 shrink-0">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60 motion-reduce:hidden" />
        <span className="relative inline-flex size-1.5 rounded-full bg-current" />
      </span>
      <span className="min-w-0 truncate">{command}</span>
    </span>
  );
}

/** One repo of a multi-repo item, so each task is one click away. */
function WorkTaskMemberRow({
  member,
  active,
  command,
  onOpen,
  onContextMenu,
}: {
  member: WorkTaskItemMember;
  active: boolean;
  /** The command running in this repo, if any. */
  command: string | null;
  onOpen: (view: WorkTaskView) => void;
  onContextMenu: (event: MouseEvent) => void;
}) {
  const { view, unseen } = member;
  const status = WORK_TASK_STATUS_PRESENTATION[view.status];
  const label = unseen ? UNSEEN_RESPONSE_PRESENTATION.label : status.label;
  return (
    <li>
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        aria-label={`${member.label}, ${label}${command !== null ? `, running ${command}` : ""}`}
        onClick={() => onOpen(view)}
        onContextMenu={onContextMenu}
        className={cn(
          ROW_CLASS,
          "h-7 items-center ps-8.5",
          active ? "bg-sidebar-row-active text-sidebar-foreground" : IDLE_CLASS,
        )}
      >
        <RepoLine member={member} command={command} />
      </button>
    </li>
  );
}
