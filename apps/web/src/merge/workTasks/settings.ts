import * as Schema from "effect/Schema";

import { useLocalStorage } from "~/hooks/useLocalStorage";

// shortcut: the fork has no client settings store yet, so this lives in localStorage per
// browser; move it there if one is added.
const WORK_TASKS_IN_SIDEBAR_KEY = "merge:work-tasks-in-sidebar";

export function useWorkTasksInSidebar() {
  return useLocalStorage(WORK_TASKS_IN_SIDEBAR_KEY, true, Schema.Boolean);
}
