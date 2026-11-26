import { describe, expect, it } from "vite-plus/test";

import {
  isPathInside,
  isWorkItemTerminalThreadId,
  workItemTerminalThreadId,
} from "./workItemTerminals.ts";

describe("work item terminal keys", () => {
  it("workItemTerminalThreadId round-trips through the guard", () => {
    expect(workItemTerminalThreadId(607374)).toBe("work-item:607374");
    expect(isWorkItemTerminalThreadId("work-item:607374")).toBe(true);
    expect(isWorkItemTerminalThreadId("thr_abc")).toBe(false);
  });
  it("isPathInside accepts the root and its children", () => {
    expect(isPathInside("/wt/esm-607374", "/wt/esm-607374")).toBe(true);
    expect(isPathInside("/wt/esm-607374/backend", "/wt/esm-607374/")).toBe(true);
    expect(isPathInside("C:\\wt\\esm\\x", "C:\\wt\\esm")).toBe(true);
  });
  it("isPathInside rejects a sibling with a shared prefix", () => {
    expect(isPathInside("/wt/esm-ui-607374", "/wt/esm")).toBe(false);
    expect(isPathInside("/wt/esm-607374-old", "/wt/esm-607374")).toBe(false);
  });
});
