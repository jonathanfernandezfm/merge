import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { SidebarSectionTitle } from "./SidebarSectionTitle";
import { SidebarFolders } from "./folders/SidebarFolders";
import { useMergeUnfiledThreads } from "./folders/state";
import { SidebarNeedsYou } from "./needsYou/SidebarNeedsYou";
import { useWithoutNeedsYou } from "./needsYou/state";
import { folderThreadMenu } from "./folders/threadMenu";
import { registerMergeThreadMenu } from "./threadMenu";
import { SidebarWorkTasks } from "./workTasks/SidebarWorkTasks";
import { useWorkTasksInSidebar } from "./workTasks/settings";
import { useThreadsOutsideWorkTasks } from "./workTasks/state";

// The sidebar seam always loads with the chat layout, before any thread menu opens.
registerMergeThreadMenu(folderThreadMenu);

/** Fork sidebar sections (Needs you, Work tasks, Folders), above Threads. Rendered at the `sidebar` seam. */
export function MergeSidebarSections({
  searchQuery,
  scopedProjectKeys,
}: {
  searchQuery: string;
  /** The sidebar's project scope; null is every project. */
  scopedProjectKeys: ReadonlySet<string> | null;
}) {
  const [workTasksInSidebar] = useWorkTasksInSidebar();
  return (
    <>
      <SidebarNeedsYou searchQuery={searchQuery} scopedProjectKeys={scopedProjectKeys} />
      {workTasksInSidebar ? <SidebarWorkTasks searchQuery={searchQuery} /> : null}
      <SidebarFolders searchQuery={searchQuery} scopedProjectKeys={scopedProjectKeys} />
      <div className="shrink-0 px-(--sidebar-content-inset)">
        <SidebarSectionTitle label="Threads" />
      </div>
    </>
  );
}

/**
 * At the `folders` seam: the Threads list leaves filed threads to Folders, task threads to their
 * Work Task, and threads that need you to the Needs you lane until they are opened.
 */
export function useMergeListedThreads<
  T extends Pick<EnvironmentThreadShell, "environmentId" | "id" | "lineage">,
>(threads: ReadonlyArray<T>): ReadonlyArray<T> {
  return useWithoutNeedsYou(useThreadsOutsideWorkTasks(useMergeUnfiledThreads(threads)));
}
