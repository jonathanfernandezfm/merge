import type {
  BranchWorkItems,
  EnvironmentId,
  WorkItem,
  WorkItemStateCategory,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { CircleCheckIcon, CircleDashedIcon, CircleDotIcon } from "lucide-react";
import { useEffect, type ReactNode } from "react";

import { toastManager } from "~/components/ui/toast";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";
import { workItemsEnvironment } from "./state";

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

/** The server's own reason (a rejected transition, an unknown type) when it gave one. */
export function failureMessage(cause: Cause.Cause<unknown>, fallback: string): string {
  const error = Cause.squash(cause);
  if (typeof error === "object" && error !== null && "detail" in error) {
    const detail = String(error.detail).trim();
    if (detail.length > 0) return detail;
  }
  return fallback;
}

export function MetaRow(props: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="grid min-h-7 min-w-0 grid-cols-[6rem_minmax(0,1fr)] items-center gap-2 text-xs sm:min-h-6">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        {props.icon}
        {props.label}
      </span>
      <span className="min-w-0 text-foreground">{props.children}</span>
    </div>
  );
}

export function Section(props: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t border-border/60 px-4 py-3">
      <div className="mb-2 flex min-h-6 items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
          {props.title}
        </h2>
        {props.actions}
      </div>
      {props.children}
    </section>
  );
}

/**
 * The branch's work items, refetched as soon as git status reports a different branch than the
 * cached result was read for (a checkout would otherwise show the previous branch's item until
 * the cache goes stale).
 */
export function useBranchWorkItems(environmentId: EnvironmentId, cwd: string) {
  const query = useEnvironmentQuery(workItemsEnvironment.branch({ environmentId, input: { cwd } }));
  const branch = useEnvironmentQuery(vcsEnvironment.status({ environmentId, input: { cwd } })).data
    ?.refName;
  const cachedBranch = query.data?.branch;
  const { refresh, isPending } = query;
  // oxlint-disable-next-line t3code/react-effect-budget -- Follows the checkout's branch from the git status stream.
  useEffect(() => {
    if (branch !== undefined && cachedBranch !== undefined && branch !== cachedBranch && !isPending)
      refresh();
  }, [branch, cachedBranch, isPending, refresh]);
  return query;
}
