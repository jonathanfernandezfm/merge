import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { SidebarFolders } from "./folders/SidebarFolders";
import { useMergeUnfiledThreads } from "./folders/state";
import { folderThreadMenu } from "./folders/threadMenu";
import { registerMergeThreadMenu } from "./threadMenu";
import { SidebarWorkTasks } from "./workTasks/SidebarWorkTasks";
import { useWorkTasksInSidebar } from "./workTasks/settings";
import { useThreadsOutsideWorkTasks } from "./workTasks/state";

// The sidebar seam always loads with the chat layout, before any thread menu opens.
registerMergeThreadMenu(folderThreadMenu);

/** Fork sidebar sections, above Threads. Rendered at the `sidebar` seam. */
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
      {workTasksInSidebar ? <SidebarWorkTasks searchQuery={searchQuery} /> : null}
      <SidebarFolders searchQuery={searchQuery} scopedProjectKeys={scopedProjectKeys} />
    </>
  );
}

/** At the `folders` seam: the Threads list leaves filed threads to Folders and task threads to their Work Task. */
export function useMergeListedThreads<
  T extends Pick<EnvironmentThreadShell, "environmentId" | "id" | "lineage">,
>(threads: ReadonlyArray<T>): ReadonlyArray<T> {
  return useThreadsOutsideWorkTasks(useMergeUnfiledThreads(threads));
}
