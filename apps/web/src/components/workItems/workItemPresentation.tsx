import type { BranchWorkItems, WorkItem, WorkItemStateCategory } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { CircleCheckIcon, CircleDashedIcon, CircleDotIcon } from "lucide-react";

import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { toastManager } from "../ui/toast";

/** One shape per category, so a dense list reads by outline as well as tint. */
const CATEGORY_GLYPH: Record<
  WorkItemStateCategory,
  { Icon: typeof CircleDashedIcon; toneClassName: string }
> = {
  proposed: { Icon: CircleDashedIcon, toneClassName: "text-muted-foreground" },
  "in-progress": { Icon: CircleDotIcon, toneClassName: "text-sky-600 dark:text-sky-400" },
  resolved: { Icon: CircleCheckIcon, toneClassName: "text-muted-foreground" },
  completed: { Icon: CircleCheckIcon, toneClassName: "text-emerald-600 dark:text-emerald-400" },
  removed: { Icon: CircleDashedIcon, toneClassName: "text-muted-foreground/60" },
};

export function stateCategory(
  item: WorkItem,
  states: BranchWorkItems["states"],
): WorkItemStateCategory | null {
  if (item.type === null || item.state === null) return null;
  return states[item.type]?.find((state) => state.name === item.state)?.category ?? null;
}

export function StateGlyph({ category }: { category: WorkItemStateCategory | null }) {
  const glyph = CATEGORY_GLYPH[category ?? "proposed"];
  return <glyph.Icon aria-hidden className={cn("size-3.5 shrink-0", glyph.toneClassName)} />;
}

export function copyText(value: string, label: string) {
  void writeTextToClipboard(value).then(
    () => toastManager.add({ type: "success", title: `${label} copied`, description: value }),
    () => toastManager.add({ type: "error", title: `Could not copy ${label.toLowerCase()}` }),
  );
}

/** The provider's own reason (a rejected transition, an unknown type) when it gave one. */
export function failureMessage(cause: Cause.Cause<unknown>, fallback: string): string {
  const error = Cause.squash(cause);
  if (typeof error === "object" && error !== null && "detail" in error) {
    const detail = String(error.detail).trim();
    if (detail.length > 0) return detail;
  }
  return fallback;
}
