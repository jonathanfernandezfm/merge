import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/**
 * The title of a top-level sidebar section (Work tasks, Folders, Threads), with a hairline above it
 * so each section reads as its own block. Shelf headers inside a section stay smaller and muted.
 */
export function SidebarSectionTitle({
  label,
  toggle,
  actions,
}: {
  label: string;
  toggle?: { expanded: boolean; onToggle: () => void; disabled?: boolean };
  actions?: ReactNode;
}) {
  const title = (
    <>
      <span className="shrink-0">{label}</span>
      {toggle ? (
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 opacity-0 transition-[opacity,transform] group-hover/section-title:opacity-100 group-focus-within/section-title:opacity-100",
            !toggle.expanded && "-rotate-90 opacity-100",
          )}
        />
      ) : null}
    </>
  );
  const titleClass =
    "flex min-w-0 flex-1 items-center gap-1 text-left text-sm font-medium text-sidebar-foreground/75";
  return (
    <div className="group/section-title flex h-9 items-center gap-1 border-t border-sidebar-border/70 ps-(--sidebar-row-content-inset)">
      {toggle ? (
        <button
          type="button"
          aria-expanded={toggle.expanded}
          disabled={toggle.disabled}
          onClick={toggle.onToggle}
          className={cn(titleClass, "cursor-pointer hover:text-sidebar-foreground")}
        >
          {title}
        </button>
      ) : (
        <h2 className={titleClass}>{title}</h2>
      )}
      {actions ? <div className="flex shrink-0 items-center">{actions}</div> : null}
    </div>
  );
}
