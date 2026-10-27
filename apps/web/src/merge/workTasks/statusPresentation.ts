import type { WorkTaskStatus } from "@t3tools/contracts";

import type { WorkTaskStatusTone } from "./logic";

export interface StatusGlyph {
  readonly ring: "dashed" | "solid" | "filled";
  readonly progress: 0 | 0.25 | 0.5 | 0.75 | 1;
  readonly mark: "none" | "x" | "check" | "alert" | "minus";
}

export interface WorkTaskStatusPresentation {
  readonly label: string;
  /** Distinct per status, so a status never depends on color alone. */
  readonly glyph: StatusGlyph;
  readonly tone: WorkTaskStatusTone;
}

export const glyph = (
  ring: StatusGlyph["ring"],
  progress: StatusGlyph["progress"] = 0,
  mark: StatusGlyph["mark"] = "none",
): StatusGlyph => ({ ring, progress, mark });

export const WORK_TASK_STATUS_PRESENTATION: Readonly<
  Record<WorkTaskStatus, WorkTaskStatusPresentation>
> = {
  "setting-up": { label: "Setting up", glyph: glyph("dashed"), tone: "info" },
  "setup-failed": { label: "Setup failed", glyph: glyph("dashed", 0, "x"), tone: "danger" },
  working: { label: "Working", glyph: glyph("dashed", 0.25), tone: "info" },
  monitoring: { label: "Monitoring", glyph: glyph("solid", 0.25), tone: "info" },
  "waiting-for-user": { label: "Needs you", glyph: glyph("filled", 0, "alert"), tone: "warning" },
  idle: { label: "Idle", glyph: glyph("solid", 0.5), tone: "neutral" },
  "ci-running": { label: "Checks running", glyph: glyph("dashed", 0.5), tone: "info" },
  "ci-failing": { label: "Checks failing", glyph: glyph("filled", 0, "x"), tone: "danger" },
  "changes-requested": {
    label: "Changes requested",
    glyph: glyph("solid", 0, "alert"),
    tone: "warning",
  },
  "addressing-comments": {
    label: "Addressing comments",
    glyph: glyph("dashed", 0.75),
    tone: "info",
  },
  "waiting-for-review": { label: "In review", glyph: glyph("solid", 0.75), tone: "neutral" },
  approved: { label: "Approved", glyph: glyph("solid", 1), tone: "success" },
  "merge-ready": { label: "Ready to merge", glyph: glyph("solid", 0, "check"), tone: "success" },
  merged: { label: "Merged", glyph: glyph("filled", 0, "check"), tone: "success" },
  archived: { label: "Archived", glyph: glyph("solid", 0, "minus"), tone: "neutral" },
};
