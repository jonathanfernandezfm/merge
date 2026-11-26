import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "~/test-fixtures";
import { threadNeedsYou } from "./logic";

const NOW = "2026-03-09T12:00:00.000Z";
const BEFORE = "2026-03-09T10:00:00.000Z";
const AFTER = "2026-03-09T11:00:00.000Z";
const latestRun = (status: "completed" | "failed") => ({
  runId: "run-1" as never,
  status,
  assistantMessageId: null,
  requestedAt: "2026-03-09T10:00:00.000Z",
  startedAt: "2026-03-09T10:00:00.000Z",
  completedAt: "2026-03-09T10:30:00.000Z",
});
const thread = (overrides: Parameters<typeof makeThreadFixture>[0]) =>
  makeThreadFixture({ latestRun: latestRun("completed"), ...overrides });

describe("threadNeedsYou", () => {
  it.each([
    ["a run finished after the last visit", thread({}), BEFORE, true],
    ["opening it acknowledges the run", thread({}), AFTER, false],
    // Upstream never counts a completion in a never-opened thread as unread.
    ["a never-opened completion", thread({}), undefined, false],
    ["an approval, even once opened", thread({ hasPendingApprovals: true }), AFTER, true],
    ["a question, even once opened", thread({ hasPendingUserInput: true }), AFTER, true],
    [
      "an unseen failure",
      thread({ latestRun: latestRun("failed"), runtime: { status: "failed" } as never }),
      BEFORE,
      true,
    ],
    [
      "a failure in a never-opened thread",
      thread({ latestRun: latestRun("failed"), runtime: { status: "failed" } as never }),
      undefined,
      true,
    ],
    [
      "a seen failure",
      thread({ latestRun: latestRun("failed"), runtime: { status: "failed" } as never }),
      AFTER,
      false,
    ],
    ["a settled thread", thread({ settledOverride: "settled" }), BEFORE, false],
    [
      "a snoozed thread",
      thread({ snoozedUntil: "2026-03-10T09:00:00.000Z" } as never),
      BEFORE,
      false,
    ],
    [
      "a running thread",
      thread({ runtime: { status: "running", activeRunId: "run-2" } as never }),
      BEFORE,
      false,
    ],
  ] as const)("%s → %s", (_, shell, lastVisitedAt, expected) => {
    expect(threadNeedsYou(shell, lastVisitedAt, NOW)).toBe(expected);
  });
});
