import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { mergeCommandPaletteActions } from "./commandPalette";

describe("mergeCommandPaletteActions", () => {
  it("offers Work Task actions everywhere and thread surfaces only with a thread", () => {
    const navigate = vi.fn();
    expect(mergeCommandPaletteActions(null, navigate).map((item) => item.title)).toEqual([
      "New Work Task…",
      "Open Work Taskboard",
    ]);
    expect(
      mergeCommandPaletteActions(
        { environmentId: EnvironmentId.make("env"), id: ThreadId.make("thread") },
        navigate,
      ).map((item) => item.title),
    ).toEqual(["New Work Task…", "Open Work Taskboard", "Open Git graph", "Open work items"]);
  });

  it("opens the Work Taskboard route", async () => {
    const navigate = vi.fn().mockResolvedValue(undefined);
    await mergeCommandPaletteActions(null, navigate)
      .find((item) => item.value === "action:open-work-taskboard")
      ?.run();
    expect(navigate).toHaveBeenCalledWith({ to: "/work-tasks" });
  });
});
