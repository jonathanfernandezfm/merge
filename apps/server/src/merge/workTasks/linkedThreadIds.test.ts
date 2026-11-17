import { afterEach, assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadShellSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import {
  loadSubscriberShellSnapshot,
  omitOlderSettledShells,
} from "../../orchestration-v2/ShellStream.ts";
import { isAutoSettlementCandidate } from "../../orchestration-v2/ThreadSettlementService.ts";
import { mergeWorkTaskThreadIds, setMergeWorkTaskThreadIds } from "./linkedThreadIds.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW_MS = 100 * DAY;

afterEach(() => setMergeWorkTaskThreadIds([]));

describe("mergeWorkTaskThreadIds", () => {
  it("replaces the whole set on each refresh", () => {
    setMergeWorkTaskThreadIds(["a", "b"]);
    setMergeWorkTaskThreadIds(["b"]);
    assert.isFalse(mergeWorkTaskThreadIds.has("a"));
    assert.isTrue(mergeWorkTaskThreadIds.has("b"));
  });
});

describe("settle-skip-work-tasks", () => {
  // Idle for a month with nothing holding it: a plain thread would settle.
  const idle = {
    id: ThreadId.make("task-thread"),
    archivedAt: null,
    settledOverride: null,
    pinnedAt: null,
    autoSettleDisabledAt: null,
    pendingRuntimeRequest: null,
    pendingGuestMessageCount: 0,
    activityRunStatus: null,
    pendingBackgroundTasks: [],
    status: "idle",
    latestUserMessageAt: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestRunId: null,
    snoozedUntil: null,
    snoozedAt: null,
  } as unknown as Parameters<typeof isAutoSettlementCandidate>[0];

  it("never auto-settles a Work Task thread", () => {
    assert.isTrue(isAutoSettlementCandidate(idle, NOW_MS));
    setMergeWorkTaskThreadIds(["task-thread"]);
    assert.isFalse(isAutoSettlementCandidate(idle, NOW_MS));
  });
});

describe("shell-keep-work-task-threads", () => {
  const row = (id: string, settledDaysAgo: number) =>
    ({
      id: ThreadId.make(id),
      projectId: ProjectId.make("project-a"),
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: ThreadId.make(id),
      },
      status: "completed",
      activityRunStatus: null,
      pendingRuntimeRequest: null,
      pendingBackgroundTasks: [],
      archivedAt: null,
      pinnedAt: null,
      snoozedUntil: null,
      settledOverride: "settled",
      settledAt: DateTime.makeUnsafe(NOW_MS - settledDaysAgo * DAY),
    }) as unknown as OrchestrationV2ThreadShell;
  const newest = Array.from({ length: 25 }, (_, index) => row(`new-${index}`, index / 10));
  // Settled long ago: the 26th newest settled thread, below the cut.
  const threads = [...newest, row("task-thread", 30), row("old", 40)];

  it("keeps a Work Task thread settled below the 25 newest in the snapshot", () => {
    setMergeWorkTaskThreadIds(["task-thread"]);
    const result = omitOlderSettledShells({
      threads,
      snapshotSequence: 1,
      now: DateTime.makeUnsafe(NOW_MS),
    });
    assert.deepStrictEqual(result.threads.map((thread) => thread.id).slice(25), ["task-thread"]);
  });

  it("reads the Work Task thread's shell for a trimmed subscriber snapshot", () =>
    Effect.gen(function* () {
      setMergeWorkTaskThreadIds(["task-thread"]);
      let requested: ReadonlyArray<string> = [];
      const { snapshot } = yield* loadSubscriberShellSnapshot({
        sql: { withTransaction: (effect: unknown) => effect } as unknown as SqlClient.SqlClient,
        listShellIndex: Effect.succeed(
          threads.map((thread) => ({ ...thread, mayBeLive: false, hasRemoteTasks: false })),
        ),
        readThreads: (threadIds) => {
          requested = threadIds ?? [];
          return Effect.succeed(
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 1,
              threads: threads.filter((thread) => threadIds?.includes(thread.id) ?? true),
              archivedThreads: [],
            } as OrchestrationV2ThreadShellSnapshot),
          );
        },
        listProjects: Effect.succeed([]),
        latestSequence: Effect.succeed(1),
        options: { omitIdleSubagents: true, omitOlderSettled: true },
      });
      assert.include(requested, "task-thread");
      assert.notInclude(requested, "old");
      assert.include(
        snapshot.threads.map((thread): string => thread.id),
        "task-thread",
      );
    }).pipe(Effect.runPromise));
});
