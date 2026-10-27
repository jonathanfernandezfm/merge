import { SidebarFolders } from "./folders/SidebarFolders";
import { folderThreadMenu } from "./folders/threadMenu";
import { registerMergeThreadMenu } from "./threadMenu";
import { SidebarWorkTasks } from "./workTasks/SidebarWorkTasks";
import { useWorkTasksInSidebar } from "./workTasks/settings";

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
