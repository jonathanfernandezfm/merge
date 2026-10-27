import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ThreadActionMenuState } from "../components/threadActionMenu.logic";
import { handleMergeThreadMenu, mergeThreadMenuItems, registerMergeThreadMenu } from "./threadMenu";

describe("mergeThreadMenuItems", () => {
  it("asks registered features for items only when the menu names its thread", () => {
    const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("t") };
    const handle = vi.fn((clicked: string) => clicked === "merge:x");
    registerMergeThreadMenu({ items: () => [{ id: "merge:x", label: "X" }], handle });
    expect(mergeThreadMenuItems({} as ThreadActionMenuState)).toEqual([]);
    expect(mergeThreadMenuItems({ mergeThreadRef: threadRef } as ThreadActionMenuState)).toEqual([
      { id: "merge:x", label: "X" },
    ]);
    expect(handleMergeThreadMenu("merge:x", threadRef)).toBe(true);
    expect(handle).toHaveBeenCalledWith("merge:x", threadRef);
    expect(handleMergeThreadMenu("rename", threadRef)).toBe(false);
  });
});
