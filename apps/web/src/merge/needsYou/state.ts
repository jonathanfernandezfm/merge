import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import {
  filterSidebarV2VisibleThreads,
  resolveThreadLastVisitedAt,
} from "~/components/Sidebar.logic";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useDelegatedUnderParent } from "~/state/entities";
import { environmentThreadShells } from "~/state/threads";
import { useUiStateStore } from "~/uiStateStore";
import { useThreadsOutsideWorkTasks } from "../workTasks/state";
import { threadNeedsYou } from "./logic";

const shellKey = (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

/**
 * Top-level threads outside Work Tasks that wait on you, in every project; filed ones included,
 * since a folder only parks them until they need you. Work Tasks bring their own.
 */
export function useNeedsYouThreads(): ReadonlyArray<EnvironmentThreadShell> {
  const shells = useAtomValue(environmentThreadShells.quietThreadShellsAtom);
  const visible = useThreadsOutsideWorkTasks(
    filterSidebarV2VisibleThreads(shells, null, useDelegatedUnderParent()),
  );
  const localVisits = useUiStateStore((state) => state.threadLastVisitedAtById);
  const now = useNowMinute();
  return visible.filter((thread) =>
    threadNeedsYou(
      thread,
      resolveThreadLastVisitedAt(thread.lastVisitedAt, localVisits[shellKey(thread)]),
      now,
    ),
  );
}

/**
 * At the `folders` seam and in Folders: the lane holds these threads until you open them, so
 * their home list leaves them out meanwhile. The same array when none is lifted.
 */
export function useWithoutNeedsYou<T extends Pick<EnvironmentThreadShell, "environmentId" | "id">>(
  threads: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const lifted = new Set(useNeedsYouThreads().map(shellKey));
  if (lifted.size === 0) return threads;
  const kept = threads.filter((thread) => !lifted.has(shellKey(thread)));
  return kept.length === threads.length ? threads : kept;
}
