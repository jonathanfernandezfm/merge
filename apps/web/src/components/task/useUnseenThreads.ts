import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useShallow } from "zustand/react/shallow";

import { useUiStateStore } from "~/uiStateStore";
import { hasUnseenCompletion } from "../Sidebar.logic";

/**
 * One flag per thread, in order: a finished turn the user has not opened yet.
 * Opening the thread stamps the visit (ChatView), which clears its flag.
 */
export function useUnseenThreadFlags(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<boolean> {
  return useUiStateStore(
    useShallow((state) =>
      threads.map((thread) =>
        hasUnseenCompletion({
          latestTurn: thread.latestTurn,
          lastVisitedAt:
            state.threadLastVisitedAtById[
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
            ],
        }),
      ),
    ),
  );
}
