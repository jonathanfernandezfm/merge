import { assert, it } from "@effect/vitest";
import type { TerminalSummary } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as TerminalManager from "../../terminal/Manager.ts";
import { listTerminalSummaries, terminalsToCloseOnArchive } from "./terminalSweep.ts";

const summary = (threadId: string, terminalId: string, cwd: string): TerminalSummary => ({
  threadId,
  terminalId,
  cwd,
  worktreePath: null,
  status: "running",
  pid: null,
  exitCode: null,
  exitSignal: null,
  hasRunningSubprocess: false,
  label: "",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const esmTab = summary("work-item:607374", "t1", "/wt/esm-607374");
const uiTab = summary("work-item:607374", "t2", "/wt/esm-ui-607374/app");
const threadTab = summary("thr_1", "t3", "/wt/esm-607374");
const ids = (tabs: ReadonlyArray<TerminalSummary>) =>
  tabs.map(({ threadId, terminalId }) => ({ threadId, terminalId }));

const base = {
  summaries: [esmTab, uiTab, threadTab],
  worktreePath: "/wt/esm-607374",
  itemThreadId: "work-item:607374",
};

it("closes only the archived worktree's terminals while siblings remain", () => {
  assert.deepStrictEqual(
    terminalsToCloseOnArchive({ ...base, siblingsRemain: true }),
    ids([esmTab, threadTab]),
  );
});

it("closes all item terminals when the last task goes", () => {
  assert.deepStrictEqual(
    terminalsToCloseOnArchive({ ...base, siblingsRemain: false }),
    ids([esmTab, uiTab, threadTab]),
  );
});

it("terminalsToCloseOnArchive with no worktree path", () => {
  const input = { ...base, worktreePath: null };
  assert.deepStrictEqual(terminalsToCloseOnArchive({ ...input, siblingsRemain: true }), []);
  assert.deepStrictEqual(
    terminalsToCloseOnArchive({ ...input, siblingsRemain: false }),
    ids([esmTab, uiTab]),
  );
});

it.effect("listTerminalSummaries returns the snapshot", () =>
  Effect.gen(function* () {
    let unsubscribed = false;
    const terminals = {
      subscribeMetadata: (listener) =>
        listener({ type: "snapshot", terminals: [esmTab] }).pipe(
          Effect.as(() => {
            unsubscribed = true;
          }),
        ),
    } as TerminalManager.TerminalManager["Service"];
    assert.deepStrictEqual(yield* listTerminalSummaries(terminals), [esmTab]);
    assert.isTrue(unsubscribed);
  }),
);
