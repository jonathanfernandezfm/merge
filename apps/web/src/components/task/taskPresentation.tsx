import type {
  OrchestrationTaskChecksState,
  OrchestrationTaskReviewState,
  OrchestrationTaskSetupStepStatus,
  ThreadOrigin,
} from "@t3tools/contracts";
import type { TaskThreadTabState } from "@t3tools/client-runtime/state/tasks";
import {
  TASK_STATUS_PRESENTATION,
  type StatusGlyph as StatusGlyphSpec,
  type TaskStatus,
  type TaskStatusTone,
} from "@t3tools/shared/taskStatus";
import {
  ArchiveIcon,
  BadgeCheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotDashedIcon,
  CircleXIcon,
  MessageSquareMoreIcon,
  MessageSquareWarningIcon,
  TriangleAlertIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";
import { useId, type ReactElement } from "react";

import { cn } from "~/lib/utils";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Spinner } from "../ui/spinner";

const MARK_PATHS: Readonly<Record<Exclude<StatusGlyphSpec["mark"], "none">, string>> = {
  x: "M5.75 5.75 10.25 10.25M10.25 5.75 5.75 10.25",
  check: "M5.25 8.25 7.25 10.25 10.75 6",
  alert: "M8 4.75V8.25M8 11V11.01",
  minus: "M5.25 8H10.75",
};

const MARK_STROKE = {
  fill: "none",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/**
 * One status ring, drawn in `currentColor` on a 16px grid. Marks on a filled
 * ring are knocked out, so the glyph sits on any surface.
 */
function StatusGlyph({ glyph, className }: { glyph: StatusGlyphSpec; className?: string }) {
  const maskId = useId();
  const markPath = glyph.mark === "none" ? null : MARK_PATHS[glyph.mark];
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={cn("size-3.5 shrink-0", className)}>
      {glyph.ring === "filled" ? (
        <>
          {markPath !== null ? (
            // A luminance mask: white keeps the disc, black cuts the mark out.
            <mask id={maskId}>
              <rect width="16" height="16" style={{ fill: "var(--color-white)" }} />
              <path d={markPath} style={{ stroke: "var(--color-black)" }} {...MARK_STROKE} />
            </mask>
          ) : null}
          <circle
            cx="8"
            cy="8"
            r="7"
            fill="currentColor"
            mask={markPath !== null ? `url(#${maskId})` : undefined}
          />
        </>
      ) : (
        <>
          <circle
            cx="8"
            cy="8"
            r="6.25"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            {...(glyph.ring === "dashed" ? { pathLength: 16, strokeDasharray: "1.3 0.7" } : {})}
          />
          {glyph.progress > 0 ? (
            // A stroke as wide as the pie's radius sweeps the pie from 12 o'clock.
            <circle
              cx="8"
              cy="8"
              r="1.75"
              fill="none"
              stroke="currentColor"
              strokeWidth="3.5"
              pathLength={100}
              strokeDasharray={`${glyph.progress * 100} 100`}
              transform="rotate(-90 8 8)"
            />
          ) : null}
          {markPath !== null ? <path d={markPath} stroke="currentColor" {...MARK_STROKE} /> : null}
        </>
      )}
    </svg>
  );
}

const TONE_CLASS: Readonly<Record<TaskStatusTone, string>> = {
  neutral: "text-muted-foreground",
  info: "text-info-foreground",
  success: "text-success-foreground",
  warning: "text-warning-foreground",
  danger: "text-destructive-foreground",
};

/** Icon and label together, so a status never depends on color alone. */
export function TaskStatusLabel({
  status,
  compact = false,
  className,
}: {
  status: TaskStatus;
  /** Icon only, with the label kept for assistive tech. */
  compact?: boolean;
  className?: string;
}) {
  const presentation = TASK_STATUS_PRESENTATION[status];
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5",
        // Merged keeps the merge purple of its sidebar icon rather than the generic success tone.
        status === "merged" ? TASK_STATUS_ICON_CLASS.merged : TONE_CLASS[presentation.tone],
        className,
      )}
      {...(compact ? { role: "img", "aria-label": presentation.label } : {})}
    >
      <StatusGlyph glyph={presentation.glyph} />
      {compact ? null : <span className="truncate text-xs">{presentation.label}</span>}
    </span>
  );
}

const TONE_DOT_CLASS: Readonly<Record<TaskStatusTone, string>> = {
  neutral: "bg-muted-foreground/60",
  info: "bg-info-foreground",
  success: "bg-success-foreground",
  warning: "bg-warning-foreground",
  danger: "bg-destructive-foreground",
};

/** A tone-tinted dot for dense lists; pair it with a text label for assistive tech. */
export function ToneDot({ tone, className }: { tone: TaskStatusTone; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT_CLASS[tone], className)}
    />
  );
}

/** A decorative spinner sized like the status glyphs; the caller carries the label. */
function WorkingSpinner({ className }: { className?: string; "aria-hidden"?: boolean }) {
  return (
    <Spinner
      aria-hidden
      aria-label={undefined}
      role={undefined}
      className={cn("size-3.5 shrink-0", className)}
    />
  );
}

/** The idle ring from `TaskStatusLabel`, so idle reads the same in both places. */
function IdleGlyph({ className }: { className?: string; "aria-hidden"?: boolean }) {
  return (
    <StatusGlyph
      glyph={TASK_STATUS_PRESENTATION.idle.glyph}
      {...(className ? { className } : {})}
    />
  );
}

/** One icon per status, so a dense row tells statuses apart by shape, not just tint. */
const TASK_STATUS_ICON: Readonly<
  Record<TaskStatus, LucideIcon | typeof WorkingSpinner | typeof IdleGlyph>
> = {
  "setting-up": WrenchIcon,
  "setup-failed": TriangleAlertIcon,
  working: WorkingSpinner,
  "waiting-for-user": CircleAlertIcon,
  idle: IdleGlyph,
  "ci-running": CircleDotDashedIcon,
  "ci-failing": CircleXIcon,
  "changes-requested": MessageSquareWarningIcon,
  "addressing-comments": MessageSquareMoreIcon,
  "waiting-for-review": PullRequestGlyph.pullRequest,
  approved: BadgeCheckIcon,
  "merge-ready": CircleCheckIcon,
  merged: PullRequestGlyph.merged,
  archived: ArchiveIcon,
};

/**
 * A hue per status for the sidebar, finer than the shared tones so a glance at the task list
 * separates CI, review, and merge stages. Resting states stay muted so active ones stand out.
 */
const TASK_STATUS_ICON_CLASS: Readonly<Record<TaskStatus, string>> = {
  "setting-up": "text-sky-600 dark:text-sky-400",
  "setup-failed": "text-destructive-foreground",
  working: "text-info-foreground",
  "waiting-for-user": "text-warning-foreground",
  idle: "text-muted-foreground",
  "ci-running": "text-cyan-600 dark:text-cyan-400",
  "ci-failing": "text-destructive-foreground",
  "changes-requested": "text-orange-600 dark:text-orange-400",
  "addressing-comments": "text-violet-600 dark:text-violet-400",
  "waiting-for-review": "text-indigo-600 dark:text-indigo-400",
  approved: "text-success-foreground",
  "merge-ready": "text-success-foreground",
  merged: "text-purple-600 dark:text-purple-400",
  archived: "text-muted-foreground/70",
};

/** A status-tinted icon for dense lists; pair it with a text label for assistive tech. */
export function TaskStatusIcon({ status, className }: { status: TaskStatus; className?: string }) {
  const Icon = TASK_STATUS_ICON[status];
  return (
    <Icon
      aria-hidden
      className={cn("size-3.5 shrink-0", TASK_STATUS_ICON_CLASS[status], className)}
    />
  );
}

export interface StatusPresentation {
  readonly label: string;
  readonly Icon: (props: { className?: string }) => ReactElement;
  readonly className: string;
}

/** A labelled glyph for the smaller state sets (tabs, checks, review, setup). */
function presentation(
  label: string,
  glyph: Partial<StatusGlyphSpec> & Pick<StatusGlyphSpec, "ring">,
  className: string,
): StatusPresentation {
  const spec: StatusGlyphSpec = { progress: 0, mark: "none", ...glyph };
  return {
    label,
    Icon: ({ className: iconClassName }) => (
      <StatusGlyph glyph={spec} {...(iconClassName ? { className: iconClassName } : {})} />
    ),
    className,
  };
}

export const TASK_THREAD_TAB_STATE_PRESENTATION: Readonly<
  Record<TaskThreadTabState, StatusPresentation>
> = {
  running: { label: "Running", Icon: WorkingSpinner, className: "text-info-foreground" },
  idle: presentation("Idle", { ring: "solid" }, "text-muted-foreground"),
  waiting: presentation("Needs you", { ring: "filled", mark: "alert" }, "text-warning-foreground"),
  completed: presentation("Completed", { ring: "solid", mark: "check" }, "text-success-foreground"),
};

/** A finished turn the user has not opened yet; pulses until the thread is read. */
export const UNSEEN_RESPONSE_PRESENTATION = presentation(
  "New response",
  { ring: "filled", mark: "check" },
  "text-success-foreground motion-safe:animate-status-pulse",
);

export const THREAD_ORIGIN_LABEL: Readonly<Record<ThreadOrigin, string>> = {
  user: "Started by you",
  "review-feedback": "Review feedback",
  "ci-failure": "CI failure",
  system: "Automated",
};

export const CHECKS_PRESENTATION: Readonly<
  Record<OrchestrationTaskChecksState, StatusPresentation | null>
> = {
  none: null,
  pending: presentation(
    "Checks running",
    { ring: "dashed", progress: 0.5 },
    "text-info-foreground",
  ),
  passing: presentation(
    "Checks passing",
    { ring: "solid", mark: "check" },
    "text-success-foreground",
  ),
  failing: presentation(
    "Checks failing",
    { ring: "filled", mark: "x" },
    "text-destructive-foreground",
  ),
};

export const REVIEW_PRESENTATION: Readonly<
  Record<OrchestrationTaskReviewState, StatusPresentation | null>
> = {
  none: null,
  pending: presentation(
    "Review pending",
    { ring: "solid", progress: 0.75 },
    "text-muted-foreground",
  ),
  approved: presentation("Approved", { ring: "solid", progress: 1 }, "text-success-foreground"),
  "changes-requested": presentation(
    "Changes requested",
    { ring: "solid", mark: "alert" },
    "text-warning-foreground",
  ),
};

export const SETUP_STEP_PRESENTATION: Readonly<
  Record<OrchestrationTaskSetupStepStatus, StatusPresentation>
> = {
  pending: presentation("Pending", { ring: "solid" }, "text-muted-foreground"),
  running: presentation("Running", { ring: "dashed", progress: 0.5 }, "text-info-foreground"),
  done: presentation("Done", { ring: "solid", mark: "check" }, "text-success-foreground"),
  failed: presentation("Failed", { ring: "filled", mark: "x" }, "text-destructive-foreground"),
  skipped: presentation("Skipped", { ring: "solid", mark: "minus" }, "text-muted-foreground"),
};
