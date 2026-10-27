import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import { FoldVerticalIcon } from "lucide-react";

import { SidebarHeaderIconButton } from "~/components/sidebar/SidebarThreadHeader";
import { getLocalStorageItem, writeLocalStorageValue } from "~/hooks/useLocalStorage";
import { appAtomRegistry } from "~/rpc/atomRegistry";

// shortcut: per browser in localStorage like the Work Tasks toggle, and other tabs pick a change
// up on reload; move it to client settings if the fork gets a store.
const COMPACT_KEY = "merge:compact-thread-rows";

function readStored(): boolean {
  try {
    return getLocalStorageItem(COMPACT_KEY, Schema.Boolean) ?? false;
  } catch {
    return false;
  }
}

// One atom for every row, so hundreds of rows never each subscribe to storage.
const compactAtom = Atom.make(readStored()).pipe(
  Atom.keepAlive,
  Atom.withLabel("merge-compact-thread-rows"),
);

/** Read by the sidebar thread row at the `compact-threads` seam: compact rows drop the branch line. */
export function useMergeCompactThreads(): boolean {
  return useAtomValue(compactAtom);
}

export function setCompactThreads(value: boolean): void {
  appAtomRegistry.set(compactAtom, value);
  writeLocalStorageValue(COMPACT_KEY, value, false, Schema.Boolean);
}

export function toggleCompactThreads(): void {
  setCompactThreads(!appAtomRegistry.get(compactAtom));
}

/** The thread list header's compact toggle (v0.0.10 placement), at the `compact-threads` seam. */
export function MergeCompactToggle() {
  const compact = useMergeCompactThreads();
  return (
    <SidebarHeaderIconButton
      label={compact ? "Show full thread rows" : "Compact thread rows"}
      aria-pressed={compact}
      onClick={toggleCompactThreads}
    >
      <FoldVerticalIcon />
    </SidebarHeaderIconButton>
  );
}
