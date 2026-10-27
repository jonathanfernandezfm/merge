import type { ScopedThreadRef } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reopenClosedView } from "~/reopenClosedView";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { GIT_GRAPH_SURFACE_ID, openMergeSurface } from "./surface";

const threadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};
const panel = () =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);

beforeEach(() => {
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
});

describe("merge right-panel surfaces", () => {
  it("opens the Git graph once and makes it the active tab", () => {
    openMergeSurface(threadRef, GIT_GRAPH_SURFACE_ID);
    openMergeSurface(threadRef, GIT_GRAPH_SURFACE_ID);
    expect(panel()).toMatchObject({
      isOpen: true,
      activeSurfaceId: GIT_GRAPH_SURFACE_ID,
      surfaces: [{ id: GIT_GRAPH_SURFACE_ID, kind: "merge" }],
    });
  });

  it("counts as a user action, so a stale automatic open is refused", () => {
    const stale = useRightPanelStore.getState().getUserActionRevision(threadRef);
    openMergeSurface(threadRef, GIT_GRAPH_SURFACE_ID);
    expect(useRightPanelStore.getState().getUserActionRevision(threadRef)).toBe(stale + 1);
    expect(
      useRightPanelStore
        .getState()
        .openProactive(threadRef, { kind: "diff", turnId: "r" as never }, stale),
    ).toBe(false);
    expect(panel().activeSurfaceId).toBe(GIT_GRAPH_SURFACE_ID);
  });

  it("reopens a closed merge surface", async () => {
    const reopened = await reopenClosedView(
      { kind: "panel-tab", threadRef, surface: { id: GIT_GRAPH_SURFACE_ID, kind: "merge" } },
      { openPreview: vi.fn(), workspaceAvailable: true },
    );
    expect(reopened).toBe(true);
    expect(panel().surfaces).toMatchObject([{ id: GIT_GRAPH_SURFACE_ID, kind: "merge" }]);
  });
});
