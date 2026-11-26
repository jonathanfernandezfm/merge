import { isPathInside, type TerminalSummary } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as TerminalManager from "../../terminal/Manager.ts";

/** Reads every terminal's summary through the metadata stream, which opens with a snapshot. */
export const listTerminalSummaries = Effect.fn("WorkTaskTerminalSweep.listTerminalSummaries")(
  function* (terminals: TerminalManager.TerminalManager["Service"]) {
    let snapshot: ReadonlyArray<TerminalSummary> = [];
    const unsubscribe = yield* terminals.subscribeMetadata((event) =>
      Effect.sync(() => {
        if (event.type === "snapshot") snapshot = event.terminals;
      }),
    );
    unsubscribe();
    return snapshot;
  },
);

/**
 * Terminals to close when a task's worktree goes: any running inside it, plus every terminal of
 * the work item's shared drawer once its last task is archived.
 */
export const terminalsToCloseOnArchive = (input: {
  readonly summaries: ReadonlyArray<TerminalSummary>;
  readonly worktreePath: string | null;
  readonly itemThreadId: string | null;
  readonly siblingsRemain: boolean;
}): ReadonlyArray<{ threadId: string; terminalId: string }> =>
  input.summaries
    .filter(
      (terminal) =>
        (input.worktreePath !== null && isPathInside(terminal.cwd, input.worktreePath)) ||
        (input.itemThreadId !== null &&
          !input.siblingsRemain &&
          terminal.threadId === input.itemThreadId),
    )
    .map(({ threadId, terminalId }) => ({ threadId, terminalId }));
