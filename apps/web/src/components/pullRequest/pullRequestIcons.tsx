import {
  createLucideIcon,
  GitPullRequestIcon,
  LayersIcon,
  Link2Icon,
  Unlink2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import type { PullRequestState } from "@t3tools/contracts";

// Merged, closed, and draft glyphs adapted from Agent Orchestrator
// (github.com/Untrivial-ai/agent-orchestrator, Apache-2.0). They drop the
// second node of Lucide's variants so each state reads as one distinct shape.
const GitMergeIcon = createLucideIcon("git-merge-arrow", [
  ["circle", { cx: "6", cy: "6", r: "3", key: "merge-node" }],
  ["circle", { cx: "18", cy: "18", r: "3", key: "merge-target" }],
  ["path", { d: "M6 9v3a6 6 0 0 0 6 6h3", key: "merge-branch" }],
  ["path", { d: "m15 15 3 3-3 3", key: "merge-arrow" }],
]);

const GitPullRequestClosedIcon = createLucideIcon("git-pull-request-closed-x", [
  ["circle", { cx: "6", cy: "6", r: "3", key: "closed-node" }],
  ["path", { d: "M6 9v12", key: "closed-branch" }],
  ["path", { d: "m15 9 6 6", key: "closed-x-a" }],
  ["path", { d: "m21 9-6 6", key: "closed-x-b" }],
]);

const GitPullRequestDraftIcon = createLucideIcon("git-pull-request-draft-dash", [
  ["circle", { cx: "6", cy: "6", r: "3", key: "draft-node" }],
  ["path", { d: "M6 9v12", key: "draft-branch" }],
  ["path", { d: "M18 6h.01", key: "draft-dot" }],
  ["path", { d: "M18 10v8", key: "draft-dash" }],
]);

export const PullRequestGlyph = {
  pullRequest: GitPullRequestIcon,
  reopen: GitPullRequestIcon,
  draft: GitPullRequestDraftIcon,
  closed: GitPullRequestClosedIcon,
  merged: GitMergeIcon,
  conflicting: TriangleAlertIcon,
  stack: LayersIcon,
  link: Link2Icon,
  unlink: Unlink2Icon,
} as const;

export type PullRequestGlyphIcon = (typeof PullRequestGlyph)[keyof typeof PullRequestGlyph];

export interface PullRequestStatePresentation {
  readonly label: string;
  readonly toneClassName: string;
  readonly Icon: PullRequestGlyphIcon;
}

export const PULL_REQUEST_STATE_PRESENTATION = {
  open: {
    label: "Open",
    toneClassName: "text-emerald-600 dark:text-emerald-300/90",
    Icon: PullRequestGlyph.pullRequest,
  },
  draft: {
    label: "Draft",
    toneClassName: "text-zinc-500 dark:text-zinc-400/80",
    Icon: PullRequestGlyph.draft,
  },
  closed: {
    label: "Closed",
    toneClassName: "text-red-600 dark:text-red-300/90",
    Icon: PullRequestGlyph.closed,
  },
  merged: {
    label: "Merged",
    toneClassName: "text-violet-600 dark:text-violet-300/90",
    Icon: PullRequestGlyph.merged,
  },
} as const satisfies Record<PullRequestState | "draft", PullRequestStatePresentation>;
