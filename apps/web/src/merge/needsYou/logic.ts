import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { hasUnseenCompletion, resolveSidebarThreadStatus } from "~/components/Sidebar.logic";

/** Statuses that wait on an answer; opening the thread does not clear them. */
const ASKING = new Set(["input", "approval", "request"]);

/**
 * Upstream's unread and attention rules for one thread, with opening as the acknowledgement: a question
 * stays until answered, a finished, failed or rate-limited run until the thread is opened.
 * Snoozed and settled threads were put away on purpose, so they stay away.
 */
export function threadNeedsYou(
  thread: EnvironmentThreadShell,
  lastVisitedAt: string | undefined,
  now: string,
): boolean {
  if (thread.settledOverride === "settled" || effectiveSnoozed(thread, { now })) return false;
  const seen = { ...thread, lastVisitedAt };
  const status = resolveSidebarThreadStatus(seen);
  if (ASKING.has(status)) return true;
  if (status === "working" || status === "preparing") return false;
  if (status === "failed" || status === "limited") {
    // Upstream counts a failure in a never-opened thread as unseen too.
    return lastVisitedAt === undefined || hasUnseenCompletion(seen);
  }
  // Like upstream's unread row: an idle ("waiting") session's finished run counts too.
  return hasUnseenCompletion(seen);
}

/** When the thread started waiting, to sort it among Work Tasks by `activityAt`. */
export function threadWaitingSince(thread: EnvironmentThreadShell): string {
  return thread.latestRun?.completedAt ?? thread.updatedAt;
}
