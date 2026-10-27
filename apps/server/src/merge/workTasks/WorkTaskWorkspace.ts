import {
  WorkTaskOperationError,
  workTaskStatusInputs,
  type WorkTaskArchiveBlocker,
  type WorkTaskArchiveCheckResult,
  type WorkTaskId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { WorkTaskStore } from "./WorkTaskStore.ts";

/** Work Task actions on the worktree and its threads. S1 has the read-only archive check. */
export class WorkTaskWorkspace extends Context.Service<
  WorkTaskWorkspace,
  {
    /** What archiving would lose. Fails with `not-found` or `archived`. */
    readonly archiveCheck: (
      taskId: WorkTaskId,
    ) => Effect.Effect<WorkTaskArchiveCheckResult, WorkTaskOperationError>;
  }
>()("t3/merge/workTasks/WorkTaskWorkspace") {}

/** @public */
export const make = Effect.gen(function* () {
  const store = yield* WorkTaskStore;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;

  const gitOut = (operation: string, cwd: string, args: ReadonlyArray<string>) =>
    git
      .execute({ operation, cwd, args, allowNonZeroExit: true })
      .pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)));

  const gitBlockers = Effect.fn("WorkTaskWorkspace.gitBlockers")(function* (cwd: string) {
    const blockers: Array<WorkTaskArchiveBlocker> = [];
    const status = yield* gitOut("WorkTaskWorkspace.archiveStatus", cwd, ["status", "--porcelain"]);
    if (status) blockers.push("uncommitted-changes");
    // Without an upstream, any commit that no remote has is unpushed.
    const ahead =
      (yield* gitOut("WorkTaskWorkspace.archiveAhead", cwd, [
        "rev-list",
        "--count",
        "@{upstream}..HEAD",
      ])) ??
      (yield* gitOut("WorkTaskWorkspace.archiveUnpushed", cwd, [
        "rev-list",
        "--count",
        "HEAD",
        "--not",
        "--remotes",
      ]));
    if (ahead !== null && Number.parseInt(ahead, 10) > 0) blockers.push("unpushed-commits");
    return blockers;
  });

  const archiveCheck = Effect.fn("WorkTaskWorkspace.archiveCheck")(function* (taskId: WorkTaskId) {
    const task = yield* store.get(taskId);
    if (task === null) {
      return yield* new WorkTaskOperationError({
        reason: "not-found",
        message: `Work Task '${taskId}' was not found.`,
      });
    }
    if (task.archivedAt !== null) {
      return yield* new WorkTaskOperationError({
        reason: "archived",
        message: `Work Task '${task.title}' is archived.`,
      });
    }
    const failed = (message: string) => (cause: unknown) =>
      new WorkTaskOperationError({ reason: "failed", message, cause });

    const blockers: Array<WorkTaskArchiveBlocker> = [];
    const path = task.workspace.path;
    if (path !== null && (yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false)))) {
      blockers.push(
        ...(yield* gitBlockers(path).pipe(
          Effect.mapError(failed("Could not inspect the worktree.")),
        )),
      );
    }

    const links = (yield* store.links()).filter((link) => link.taskId === taskId);
    const shells = (yield* Effect.forEach(links, (link) =>
      projections.getThreadShell(link.threadId),
    ).pipe(Effect.mapError(failed("Could not read the Work Task threads.")))).filter(
      (shell) => shell !== null,
    );
    const { threads, pullRequest } = workTaskStatusInputs({ taskId, task, links, shells });
    if (pullRequest?.state === "open" || pullRequest?.state === "draft") {
      blockers.push("pull-request-open");
    }
    if (threads.some((thread) => thread.state === "running" || thread.state === "waiting")) {
      blockers.push("agent-running");
    }
    return { blockers };
  });

  return WorkTaskWorkspace.of({ archiveCheck });
});

export const layer = Layer.effect(WorkTaskWorkspace, make);
