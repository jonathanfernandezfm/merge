import { MERGE_WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { create } from "zustand";

import { connectionAtomRuntime } from "~/connection/runtime";

export const gitGraphEnvironment = {
  log: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:merge:git-graph-log",
    tag: MERGE_WS_METHODS.gitGraphLog,
    staleTimeMs: 5_000,
  }),
  commitDiff: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:merge:git-graph-commit-diff",
    tag: MERGE_WS_METHODS.gitGraphCommitDiff,
    staleTimeMs: 5 * 60_000,
  }),
};

/** The compare-against ref per thread; null means the branch's automatic base. */
export const useGitGraphBaseRefStore = create<{
  byThreadKey: Record<string, string | null>;
  setBaseRef: (threadKey: string, baseRef: string | null) => void;
}>()((set) => ({
  byThreadKey: {},
  setBaseRef: (threadKey, baseRef) =>
    set((state) => ({ byThreadKey: { ...state.byThreadKey, [threadKey]: baseRef } })),
}));
