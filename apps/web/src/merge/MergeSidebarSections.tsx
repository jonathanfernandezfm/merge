import { SidebarWorkTasks } from "./workTasks/SidebarWorkTasks";
import { useWorkTasksInSidebar } from "./workTasks/settings";

/** Fork sidebar sections. Rendered at the `sidebar` seam. */
export function MergeSidebarSections({ searchQuery }: { searchQuery: string }) {
  const [workTasksInSidebar] = useWorkTasksInSidebar();
  return workTasksInSidebar ? <SidebarWorkTasks searchQuery={searchQuery} /> : null;
}
