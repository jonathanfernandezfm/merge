import type {
  WorkTaskChecksState,
  WorkTaskReviewState,
  WorkTaskSetupStepStatus,
  WorkTaskStatus,
  WorkTaskThreadOrigin,
} from "@t3tools/contracts";
import {
  ArchiveIcon,
  BadgeCheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotDashedIcon,
  CircleXIcon,
  EyeIcon,
  MessageSquareMoreIcon,
  MessageSquareWarningIcon,
  TriangleAlertIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";
import { useId, type ReactElement } from "react";

import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import type { WorkTaskStatusTone, WorkTaskTabState } from "./logic";
import {
  glyph as makeGlyph,
  WORK_TASK_STATUS_PRESENTATION,
  type StatusGlyph as StatusGlyphSpec,
} from "./statusPresentation";

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

/** One status ring in `currentColor` on a 16px grid; marks on a filled ring are knocked out. */
function StatusGlyph({ glyph, className }: { glyph: StatusGlyphSpec; className?: string }) {
  const maskId = useId();
  const markPath = glyph.mark === "none" ? null : MARK_PATHS[glyph.mark];
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={cn("size-3.5 shrink-0", className)}>
      {glyph.ring === "filled" ? (
        <>
          {markPath !== null ? (
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

const TONE_CLASS: Readonly<Record<WorkTaskStatusTone, string>> = {
  neutral: "text-muted-foreground",
  info: "text-info-foreground",
  success: "text-success-foreground",
  warning: "text-warning-foreground",
  danger: "text-destructive-foreground",
};

/** Icon and label together, so a status never depends on color alone. */
export function WorkTaskStatusLabel({
  status,
  compact = false,
  className,
}: {
  status: WorkTaskStatus;
  /** Icon only, with the label kept for assistive tech. */
  compact?: boolean;
  className?: string;
}) {
  const presentation = WORK_TASK_STATUS_PRESENTATION[status];
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5",
        TONE_CLASS[presentation.tone],
        className,
      )}
      {...(compact ? { role: "img", "aria-label": presentation.label } : {})}
    >
      <StatusGlyph glyph={presentation.glyph} />
      {compact ? null : <span className="truncate text-xs">{presentation.label}</span>}
    </span>
  );
}

const TONE_DOT_CLASS: Readonly<Record<WorkTaskStatusTone, string>> = {
  neutral: "bg-muted-foreground/60",
  info: "bg-info-foreground",
  success: "bg-success-foreground",
  warning: "bg-warning-foreground",
  danger: "bg-destructive-foreground",
};

export function ToneDot({ tone }: { tone: WorkTaskStatusTone }) {
  return (
    <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT_CLASS[tone])} />
  );
}

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

function IdleGlyph({ className }: { className?: string; "aria-hidden"?: boolean }) {
  return (
    <StatusGlyph
      glyph={WORK_TASK_STATUS_PRESENTATION.idle.glyph}
      {...(className ? { className } : {})}
    />
  );
}

/** One icon per status, so a dense row tells statuses apart by shape, not just tint. */
const STATUS_ICON: Readonly<
  Record<WorkTaskStatus, LucideIcon | typeof WorkingSpinner | typeof IdleGlyph>
> = {
  "setting-up": WrenchIcon,
  "setup-failed": TriangleAlertIcon,
  working: WorkingSpinner,
  monitoring: EyeIcon,
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

export function WorkTaskStatusIcon({ status }: { status: WorkTaskStatus }) {
  const Icon = STATUS_ICON[status];
  return (
    <Icon
      aria-hidden
      className={cn("size-3.5 shrink-0", TONE_CLASS[WORK_TASK_STATUS_PRESENTATION[status].tone])}
    />
  );
}

export interface StatusPresentation {
  readonly label: string;
  readonly Icon: (props: { className?: string }) => ReactElement;
  readonly className: string;
}

function presentation(label: string, spec: StatusGlyphSpec, className: string): StatusPresentation {
  return {
    label,
    Icon: ({ className: iconClassName }) => (
      <StatusGlyph glyph={spec} {...(iconClassName ? { className: iconClassName } : {})} />
    ),
    className,
  };
}

export const TAB_STATE_PRESENTATION: Readonly<Record<WorkTaskTabState, StatusPresentation>> = {
  running: { label: "Running", Icon: WorkingSpinner, className: "text-info-foreground" },
  monitoring: {
    label: "Monitoring",
    Icon: ({ className }) => <EyeIcon aria-hidden className={cn("size-3.5 shrink-0", className)} />,
    className: "text-info-foreground",
  },
  idle: presentation("Idle", makeGlyph("solid"), "text-muted-foreground"),
  waiting: presentation("Needs you", makeGlyph("filled", 0, "alert"), "text-warning-foreground"),
  completed: presentation("Completed", makeGlyph("solid", 0, "check"), "text-success-foreground"),
};

/** A finished run the user has not opened yet (upstream visit tracking). */
export const UNSEEN_RESPONSE_PRESENTATION = presentation(
  "New response",
  makeGlyph("filled", 0, "check"),
  "text-success-foreground",
);

export const THREAD_ORIGIN_LABEL: Readonly<Record<WorkTaskThreadOrigin, string>> = {
  user: "Started by you",
  "review-feedback": "Review feedback",
  "ci-failure": "CI failure",
  system: "Automated",
};

export const CHECKS_PRESENTATION: Readonly<Record<WorkTaskChecksState, StatusPresentation | null>> =
  {
    none: null,
    pending: presentation("Checks running", makeGlyph("dashed", 0.5), "text-info-foreground"),
    passing: presentation(
      "Checks passing",
      makeGlyph("solid", 0, "check"),
      "text-success-foreground",
    ),
    failing: presentation(
      "Checks failing",
      makeGlyph("filled", 0, "x"),
      "text-destructive-foreground",
    ),
  };

export const REVIEW_PRESENTATION: Readonly<Record<WorkTaskReviewState, StatusPresentation | null>> =
  {
    none: null,
    pending: presentation("Review pending", makeGlyph("solid", 0.75), "text-muted-foreground"),
    approved: presentation("Approved", makeGlyph("solid", 1), "text-success-foreground"),
    "changes-requested": presentation(
      "Changes requested",
      makeGlyph("solid", 0, "alert"),
      "text-warning-foreground",
    ),
  };

export const SETUP_STEP_PRESENTATION: Readonly<
  Record<WorkTaskSetupStepStatus, StatusPresentation>
> = {
  pending: presentation("Pending", makeGlyph("solid"), "text-muted-foreground"),
  running: presentation("Running", makeGlyph("dashed", 0.5), "text-info-foreground"),
  done: presentation("Done", makeGlyph("solid", 0, "check"), "text-success-foreground"),
  failed: presentation("Failed", makeGlyph("filled", 0, "x"), "text-destructive-foreground"),
  skipped: presentation("Skipped", makeGlyph("solid", 0, "minus"), "text-muted-foreground"),
};
