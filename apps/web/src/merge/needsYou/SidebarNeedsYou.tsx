import { memo, type ReactNode } from "react";

import { SidebarGroup } from "~/components/ui/sidebar";
import { TooltipProvider } from "~/components/ui/tooltip";
import { MergeThreadRow, useMergeThreadRowProps } from "../MergeThreadRow";
import { useWorkTasksInSidebar } from "../workTasks/settings";
import { useWorkTaskRowRenderer } from "../workTasks/SidebarWorkTaskItems";
import {
  useHiddenWorkTaskProjects,
  useWorkTaskSidebarActions,
} from "../workTasks/SidebarWorkTasks";
import { useWorkTaskItems } from "../workTasks/state";
import { threadWaitingSince } from "./logic";
import { useNeedsYouThreads } from "./state";
import "./needsYou.css";

/**
 * Everything waiting on you, Work Tasks and threads alike, newest first, above the sections they
 * come from. Each stays here until opened (or answered, for a question), then goes back home.
 * Hidden while searching, where every item shows in its own section.
 */
export const SidebarNeedsYou = memo(function SidebarNeedsYou({
  searchQuery,
  scopedProjectKeys,
}: {
  searchQuery: string;
  scopedProjectKeys: ReadonlySet<string> | null;
}) {
  const [workTasksInSidebar] = useWorkTasksInSidebar();
  const { hiddenProjectKeys } = useHiddenWorkTaskProjects();
  const { activeKey, onOpen, onContextMenu } = useWorkTaskSidebarActions();
  const renderItem = useWorkTaskRowRenderer({ activeKey, onOpen, onContextMenu });
  const rowProps = useMergeThreadRowProps();
  // Same project filter as the Work tasks section, so a hidden project stays hidden here too.
  const items = useWorkTaskItems(workTasksInSidebar).filter(
    (item) =>
      item.section === "attention" &&
      item.members.some(
        ({ view }) => !hiddenProjectKeys.has(`${view.task.environmentId}:${view.task.projectId}`),
      ),
  );
  const threads = useNeedsYouThreads().filter(
    (thread) =>
      scopedProjectKeys === null ||
      scopedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`),
  );

  if (searchQuery.trim().length > 0) return null;
  const entries: Array<{ at: string; node: ReactNode }> = [
    ...items.map((item) => ({ at: item.activityAt, node: renderItem(item) })),
    ...threads.map((thread) => ({
      at: threadWaitingSince(thread),
      node: <MergeThreadRow key={thread.id} thread={thread} {...rowProps(thread)} />,
    })),
  ].toSorted((a, b) => b.at.localeCompare(a.at));
  if (entries.length === 0) return null;

  return (
    <SidebarGroup className="shrink-0">
      <section
        aria-label={`Needs you, ${entries.length}`}
        data-needs-you="lane"
        className="mb-2 rounded-xl p-1"
      >
        <h2 data-needs-you="title" className="flex h-7 items-center gap-2 px-2 text-sm font-medium">
          Needs you
          <span data-needs-you="count" className="ms-auto rounded-full px-1.5 text-xs tabular-nums">
            {entries.length}
          </span>
        </h2>
        <TooltipProvider delay={150} closeDelay={0} timeout={400}>
          {/* Thread rows get the same frame as work task cards; upstream's row owns its <li>. */}
          <ul className="flex flex-col gap-1.5 [&>li[data-thread-item]]:overflow-hidden [&>li[data-thread-item]]:rounded-lg [&>li[data-thread-item]]:border [&>li[data-thread-item]]:border-sidebar-border">
            {entries.map(({ node }) => node)}
          </ul>
        </TooltipProvider>
      </section>
    </SidebarGroup>
  );
});
