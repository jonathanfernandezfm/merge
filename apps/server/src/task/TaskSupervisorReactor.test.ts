import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  TaskId,
  ThreadId,
  type PullRequestActivity,
  type PullRequestDetail,
  type PullRequestReviewThread,
  type PullRequestSummary,
  type RepositoryIdentity,
  type ThreadOrigin,
} from "@t3tools/contracts";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as TaskScmEvents from "../persistence/TaskScmEvents.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import { decodeThreadsJson } from "../pullRequest/azureDevOpsPullRequestJson.ts";
import {
  PullRequestService,
  type PullRequestMergeEvent,
} from "../pullRequest/PullRequestService.ts";
import * as TaskSupervisorReactor from "./TaskSupervisorReactor.ts";
import { TaskWorkspaceService } from "./TaskWorkspaceService.ts";

const PROJECT_ID = ProjectId.make("project-supervisor");
const TASK_ID = TaskId.make("task-supervisor");
const BRANCH = "feature/widgets";
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const MODEL = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };

const IDENTITY: RepositoryIdentity = {
  canonicalKey: "github.com/owner/repo",
  locator: { source: "git-remote", remoteName: "origin", remoteUrl: "git@github.com:owner/repo" },
  displayName: "owner/repo",
  provider: "github",
  owner: "owner",
  name: "repo",
};

/** What the fake host reports. Tests mutate it between evaluations. */
interface Host {
  pullRequest: { state: "open" | "merged"; updatedAt: string; mergedAt?: string } | null;
  activity: Pick<PullRequestActivity, "comments" | "reviewThreads">;
  summaryReads: number;
  /** The signed-in account the detail reports. */
  viewer: string;
}

interface CreatedThread {
  readonly threadId: ThreadId;
  /** Ledger rows naming this thread when createThread was called. */
  readonly claimedBeforeCreate: number;
  readonly taskId: TaskId;
  readonly origin: ThreadOrigin | undefined;
  readonly title: string | undefined;
  readonly initialMessage: string | undefined;
}

const reviewThread = (id: string, body: string): PullRequestReviewThread => ({
  id: `thread-${id}`,
  path: "src/PermissionService.ts",
  line: 184,
  side: "right",
  isResolved: false,
  isOutdated: false,
  comments: [
    {
      id,
      author: { login: "sarah", name: "Sarah", avatarUrl: null },
      body,
      createdAt: CREATED_AT,
      url: null,
    },
  ],
});

const makeLayer = (
  host: Host,
  created: Queue.Queue<CreatedThread>,
  merges: PubSub.PubSub<PullRequestMergeEvent>,
) => {
  const summary = (): PullRequestSummary => {
    host.summaryReads += 1;
    const pr = host.pullRequest!;
    return {
      provider: "github",
      projectId: PROJECT_ID,
      repository: "owner/repo",
      number: 7,
      title: "Widgets",
      url: "https://github.com/owner/repo/pull/7",
      state: pr.state,
      headBranch: BRANCH,
      baseBranch: "main",
      updatedAt: pr.updatedAt,
      mergedAt: pr.mergedAt ?? null,
      reviewDecision: "review-required",
      checksState: "passing",
    };
  };

  // Stands in for TaskWorkspaceService.createThread: creates the thread through
  // the real engine and reports what the supervisor asked for.
  const workspaces = Layer.effect(
    TaskWorkspaceService,
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const ledger = yield* TaskScmEvents.make;
      return TaskWorkspaceService.of({
        create: () => Effect.die("unused"),
        retrySetup: () => Effect.die("unused"),
        archiveCheck: () => Effect.die("unused"),
        archive: () => Effect.die("archive must never run from the supervisor"),
        awaitSetup: () => Effect.void,
        createThread: (input) =>
          Effect.gen(function* () {
            const threadId = input.threadId ?? ThreadId.make(`auto-${yield* Queue.size(created)}`);
            const claimedBeforeCreate = (yield* ledger.listByTask(input.taskId)).filter(
              (row) => row.state === "handling" && row.handlingThreadId === threadId,
            ).length;
            yield* engine.dispatch({
              type: "thread.create",
              commandId: CommandId.make(`cmd-${threadId}`),
              threadId,
              projectId: PROJECT_ID,
              title: input.title ?? "Automated",
              modelSelection: MODEL,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: BRANCH,
              worktreePath: null,
              taskId: input.taskId,
              origin: input.origin ?? null,
              createdAt: CREATED_AT,
            });
            yield* Queue.offer(created, {
              threadId,
              claimedBeforeCreate,
              taskId: input.taskId,
              origin: input.origin,
              title: input.title,
              initialMessage: input.initialMessage,
            });
            return { threadId };
          }).pipe(Effect.orDie),
      });
    }),
  );

  return TaskSupervisorReactor.layer.pipe(
    Layer.provideMerge(workspaces),
    Layer.provideMerge(
      Layer.mergeAll(
        OrchestrationEngineLive.pipe(
          Layer.provide(OrchestrationProjectionSnapshotQueryLive),
          Layer.provide(OrchestrationProjectionPipelineLive),
        ),
        OrchestrationProjectionSnapshotQueryLive,
      ),
    ),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(
      Layer.mock(GitManager.GitManager)({
        branchPullRequest: () =>
          Effect.sync(() =>
            host.pullRequest === null
              ? null
              : {
                  number: 7,
                  title: "Widgets",
                  url: "https://github.com/owner/repo/pull/7",
                  baseRef: "main",
                  headRef: BRANCH,
                  state: host.pullRequest.state,
                  updatedAt: host.pullRequest.updatedAt,
                  repositoryKey: "github.com/owner/repo",
                },
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(PullRequestService)({
        summary: () => Effect.sync(summary),
        subscribeMerges: PubSub.subscribe(merges).pipe(Effect.map(Stream.fromSubscription)),
        detail: () =>
          Effect.sync(() => ({ checks: [], viewer: host.viewer }) as unknown as PullRequestDetail),
        activity: () =>
          Effect.sync(() => ({
            ...host.activity,
            commentCount: host.activity.comments.length,
            commentsTruncated: false,
            commits: [],
          })),
      }),
    ),
    Layer.provide(
      Layer.succeed(RepositoryIdentityResolver, { resolve: () => Effect.succeed(IDENTITY) }),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-task-supervisor-" })),
    Layer.provideMerge(NodeServices.layer),
  );
};

interface Fixture {
  readonly host: Host;
  readonly created: Queue.Queue<CreatedThread>;
  readonly merges: PubSub.PubSub<PullRequestMergeEvent>;
  readonly workspacePath: string;
}

/** A project and a ready task whose worktree is a real temp directory. */
const withTask = <A, E, R>(
  options: {
    readonly autoHandleReviewFeedback: boolean;
    readonly host?: Partial<Host>;
    readonly setupStatus?: "running" | "ready";
  },
  body: (fixture: Fixture) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-task-supervisor-" });
      const workspacePath = path.join(directory, "worktree");
      yield* fs.makeDirectory(workspacePath);
      const host: Host = {
        pullRequest: { state: "open", updatedAt: "2026-01-02T00:00:00.000Z" },
        activity: { comments: [], reviewThreads: [] },
        summaryReads: 0,
        viewer: "me",
        ...options.host,
      };
      const created = yield* Queue.unbounded<CreatedThread>();
      const merges = yield* PubSub.unbounded<PullRequestMergeEvent>();
      return yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-project"),
          projectId: PROJECT_ID,
          title: "Project",
          workspaceRoot: directory,
          createdAt: CREATED_AT,
        });
        yield* engine.dispatch({
          type: "task.create",
          commandId: CommandId.make("cmd-task"),
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          title: "ABC-123 – Permissions",
          description: null,
          workspace: {
            path: workspacePath,
            branch: BRANCH,
            remoteName: "origin",
            remoteBranch: BRANCH,
            baseBranch: "main",
            setup: {
              status: options.setupStatus ?? "ready",
              steps: [],
              error: null,
              updatedAt: CREATED_AT,
            },
          },
          autoHandleReviewFeedback: options.autoHandleReviewFeedback,
          autoHandleCIFailures: false,
          createdAt: CREATED_AT,
        });
        return yield* body({ host, created, merges, workspacePath });
      }).pipe(Effect.provide(makeLayer(host, created, merges)));
    }),
  );

const evaluate = Effect.gen(function* () {
  const reactor = yield* TaskSupervisorReactor.TaskSupervisorReactor;
  yield* reactor.requestEvaluation(TASK_ID);
  yield* reactor.drain;
});

const readTask = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery;
  return Option.getOrThrow(yield* snapshots.getTaskById(TASK_ID));
});

const ledgerRows = Effect.gen(function* () {
  const ledger = yield* TaskScmEvents.make;
  return yield* ledger.listByTask(TASK_ID);
});

/** A user thread of the task with a live session. */
const startUserThread = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const threadId = ThreadId.make("user-thread");
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make("cmd-user-thread"),
    threadId,
    projectId: PROJECT_ID,
    title: "Implementation",
    modelSelection: MODEL,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: BRANCH,
    worktreePath: null,
    taskId: TASK_ID,
    origin: "user",
    createdAt: CREATED_AT,
  });
  const setSession = (status: "running" | "ready", tag: string) =>
    engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make(`cmd-session-${tag}`),
      threadId,
      session: {
        threadId,
        status,
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: CREATED_AT,
      },
      createdAt: CREATED_AT,
    });
  yield* setSession("running", "running");
  return { stop: setSession("ready", "stopped") };
});

const addComment = (host: Host, id: string, body: string, updatedAt: string) => {
  host.activity = {
    ...host.activity,
    reviewThreads: [...host.activity.reviewThreads, reviewThread(id, body)],
  };
  host.pullRequest = { state: "open", updatedAt };
};

/** Azure DevOps threads as `az devops invoke` returns them, read by the real decoder. */
const azureDevOpsActivity = (threads: ReadonlyArray<Record<string, unknown>>) => {
  const decoded = decodeThreadsJson(JSON.stringify({ value: threads }));
  if (!Result.isSuccess(decoded)) throw new Error("fixture must decode");
  return { comments: decoded.success.comments, reviewThreads: decoded.success.threads };
};

const azureDevOpsComment = (id: number, uniqueName: string, content: string, at: string) => ({
  id,
  author: { displayName: uniqueName, uniqueName },
  content,
  publishedDate: at,
  commentType: "text",
});

/** A review comment a dispatch claimed, as a crash would leave it. */
const insertClaimedComment = (input: {
  readonly id: string;
  readonly handlingThreadId: ThreadId | null;
  readonly claimedAt: string | null;
}) =>
  Effect.gen(function* () {
    const ledger = yield* TaskScmEvents.make;
    yield* ledger.insertIgnore([
      {
        id: input.id,
        taskId: TASK_ID,
        providerEventKey: `github:owner/repo:7:comment:${input.id}`,
        type: "review-comment-added",
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        payloadJson: JSON.stringify({
          commentId: input.id,
          reviewThreadId: null,
          author: "Sarah",
          body: `Remark ${input.id}`,
          path: null,
          line: null,
          url: null,
          createdAt: CREATED_AT,
        }),
        observedAt: CREATED_AT,
        state: "handling",
      },
    ]);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE task_scm_events
      SET handling_thread_id = ${input.handlingThreadId}, handled_at = ${input.claimedAt}
      WHERE id = ${input.id}
    `;
  });

it.layer(NodeServices.layer)("TaskSupervisorReactor", (it) => {
  it.effect(
    "acts on the one open Azure DevOps thread, with its line, and skips the resolved one",
    () =>
      withTask(
        { autoHandleReviewFeedback: true, host: { viewer: "bilal@acme.dev" } },
        ({ host, created }) =>
          Effect.gen(function* () {
            yield* evaluate;
            host.activity = azureDevOpsActivity([
              {
                id: 7,
                status: "active",
                threadContext: {
                  filePath: "/src/PermissionService.ts",
                  rightFileStart: { line: 184, offset: 1 },
                },
                comments: [
                  azureDevOpsComment(
                    1,
                    "sarah@acme.dev",
                    "Merge inherited permissions",
                    "2026-01-03T00:00:00Z",
                  ),
                  // The signed-in account's own reply, cased differently by Azure.
                  azureDevOpsComment(2, "Bilal@Acme.dev", "On it", "2026-01-03T01:00:00Z"),
                ],
              },
              {
                id: 8,
                status: "fixed",
                threadContext: {
                  filePath: "/src/PermissionService.ts",
                  rightFileStart: { line: 3, offset: 1 },
                },
                comments: [
                  azureDevOpsComment(1, "julius@acme.dev", "Unused import", "2026-01-03T00:30:00Z"),
                ],
              },
            ]);
            host.pullRequest = { state: "open", updatedAt: "2026-01-03T02:00:00.000Z" };
            yield* evaluate;

            assert.strictEqual(yield* Queue.size(created), 1);
            const thread = yield* Queue.take(created);
            expect(thread.initialMessage).toContain("Merge inherited permissions");
            expect(thread.initialMessage).toContain("Line: 184");
            expect(thread.initialMessage).not.toContain("Unused import");
            expect(thread.initialMessage).not.toContain("On it");
            const comments = (yield* ledgerRows).filter(
              (row) => row.type === "review-comment-added",
            );
            expect(comments.map((row) => [row.providerEventKey, row.state])).toEqual([
              ["github:owner/repo:7:comment:7:1", "handled"],
            ]);
          }),
      ),
  );

  it.effect("recovers comments a crashed dispatch left claimed when it starts", () =>
    withTask({ autoHandleReviewFeedback: true }, ({ created }) =>
      Effect.gen(function* () {
        yield* evaluate;
        // One claim created its thread before the crash, one minted a thread
        // id that never reached the read model, and one predates thread ids.
        const engine = yield* OrchestrationEngineService;
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-before-crash"),
          threadId: ThreadId.make("thread-before-crash"),
          projectId: PROJECT_ID,
          title: "PR feedback",
          modelSelection: MODEL,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: BRANCH,
          worktreePath: null,
          taskId: TASK_ID,
          origin: "review-feedback",
          createdAt: CREATED_AT,
        });
        yield* insertClaimedComment({
          id: "orphan",
          handlingThreadId: null,
          claimedAt: "2026-01-02T00:00:00.000Z",
        });
        yield* insertClaimedComment({
          id: "minted",
          handlingThreadId: ThreadId.make("thread-never-created"),
          claimedAt: "2026-01-02T00:00:00.000Z",
        });
        yield* insertClaimedComment({
          id: "delivered",
          handlingThreadId: ThreadId.make("thread-before-crash"),
          claimedAt: "2026-01-02T00:00:00.000Z",
        });

        const reactor = yield* TaskSupervisorReactor.TaskSupervisorReactor;
        yield* reactor.start();
        // The thread created for the released claim is the receipt.
        const thread = yield* Queue.take(created);
        yield* reactor.drain;

        expect(thread.initialMessage).toContain("Remark orphan");
        expect(thread.initialMessage).toContain("Remark minted");
        expect(thread.initialMessage).not.toContain("Remark delivered");
        const states = Object.fromEntries(
          (yield* ledgerRows)
            .filter((row) => row.type === "review-comment-added")
            .map((row) => [row.id, [row.state, row.handlingThreadId]]),
        );
        expect(states).toEqual({
          orphan: ["handled", thread.threadId],
          minted: ["handled", thread.threadId],
          delivered: ["handled", "thread-before-crash"],
        });
      }),
    ),
  );

  it.effect("releases only claims older than the cutoff while running", () =>
    withTask({ autoHandleReviewFeedback: false }, () =>
      Effect.gen(function* () {
        yield* insertClaimedComment({
          id: "stale",
          handlingThreadId: null,
          claimedAt: "2026-01-01T00:00:00.000Z",
        });
        yield* insertClaimedComment({
          id: "fresh",
          handlingThreadId: null,
          claimedAt: "2026-01-01T00:20:00.000Z",
        });
        const ledger = yield* TaskScmEvents.make;
        yield* ledger.recoverStuck({ claimedBefore: "2026-01-01T00:10:00.000Z" });

        const states = Object.fromEntries(
          (yield* ledgerRows).map((row) => [row.id, [row.state, row.handledAt]]),
        );
        expect(states).toEqual({
          stale: ["pending", null],
          fresh: ["handling", "2026-01-01T00:20:00.000Z"],
        });
      }),
    ),
  );

  it.effect("associates the open pull request of the task branch with the task", () =>
    withTask({ autoHandleReviewFeedback: false }, () =>
      Effect.gen(function* () {
        yield* evaluate;
        const task = yield* readTask;
        expect(task.pullRequest).toMatchObject({
          provider: "github",
          number: 7,
          state: "open",
          checks: "passing",
          review: "pending",
          headBranch: BRANCH,
        });
        const rows = yield* ledgerRows;
        expect(rows.map((row) => [row.providerEventKey, row.state])).toEqual([
          ["github:owner/repo:7:discovered", "ignored"],
          ["github:owner/repo:7:checks:2026-01-02T00:00:00.000Z:passing", "ignored"],
        ]);
      }),
    ),
  );

  it.effect("creates exactly one review-feedback thread per new comment, once", () =>
    withTask({ autoHandleReviewFeedback: true }, ({ host, created }) =>
      Effect.gen(function* () {
        yield* evaluate;
        addComment(host, "c1", "Handle inherited permissions", "2026-01-03T00:00:00.000Z");
        yield* evaluate;

        assert.strictEqual(yield* Queue.size(created), 1);
        const thread = yield* Queue.take(created);
        expect(thread.taskId).toBe(TASK_ID);
        expect(thread.origin).toBe("review-feedback");
        // The claim names the thread before the thread is created.
        expect(thread.claimedBeforeCreate).toBe(1);
        expect(thread.title).toMatch(/^PR feedback – /);
        expect(thread.initialMessage).toContain("Handle inherited permissions");
        expect(thread.initialMessage).toContain("File: src/PermissionService.ts\nLine: 184");
        expect(thread.initialMessage).toContain("Pull request: #7");

        const snapshots = yield* ProjectionSnapshotQuery;
        const shell = Option.getOrThrow(yield* snapshots.getThreadShellById(thread.threadId));
        expect(shell.taskId).toBe(TASK_ID);
        expect(shell.origin).toBe("review-feedback");

        const comment = (yield* ledgerRows).find((row) => row.type === "review-comment-added");
        expect(comment).toMatchObject({ state: "handled", handlingThreadId: thread.threadId });

        // The host reports the same comment again on a later revision.
        host.pullRequest = { state: "open", updatedAt: "2026-01-04T00:00:00.000Z" };
        yield* evaluate;
        yield* evaluate;
        assert.strictEqual(yield* Queue.size(created), 0);
      }),
    ),
  );

  it.effect("baselines comments that existed when the pull request was linked", () =>
    withTask(
      {
        autoHandleReviewFeedback: true,
        host: {
          activity: { comments: [], reviewThreads: [reviewThread("old", "Old remark")] },
        },
      },
      ({ created }) =>
        Effect.gen(function* () {
          yield* evaluate;
          yield* evaluate;
          assert.strictEqual(yield* Queue.size(created), 0);
          const comment = (yield* ledgerRows).find((row) => row.type === "review-comment-added");
          expect(comment?.state).toBe("ignored");
        }),
    ),
  );

  it.effect("queues feedback while a task thread runs and dispatches it when that stops", () =>
    withTask({ autoHandleReviewFeedback: true }, ({ host, created }) =>
      Effect.gen(function* () {
        yield* evaluate;
        const userThread = yield* startUserThread;
        addComment(host, "c1", "Rename this", "2026-01-03T00:00:00.000Z");
        yield* evaluate;
        assert.strictEqual(yield* Queue.size(created), 0);
        const pending = (yield* ledgerRows).find((row) => row.type === "review-comment-added");
        expect(pending?.state).toBe("pending");

        const reactor = yield* TaskSupervisorReactor.TaskSupervisorReactor;
        yield* reactor.start();
        yield* userThread.stop;
        // The session-stop event wakes the supervisor; the created thread is its receipt.
        const thread = yield* Queue.take(created);
        yield* reactor.drain;
        yield* evaluate;
        assert.strictEqual(yield* Queue.size(created), 0);
        expect(thread.initialMessage).toContain("Rename this");
        const handled = (yield* ledgerRows).find((row) => row.type === "review-comment-added");
        expect(handled).toMatchObject({ state: "handled", handlingThreadId: thread.threadId });
      }),
    ),
  );

  it.effect("records a merge without cleaning up and stops supervising the task", () =>
    withTask({ autoHandleReviewFeedback: true }, ({ host, created, workspacePath }) =>
      Effect.gen(function* () {
        yield* evaluate;
        host.pullRequest = {
          state: "merged",
          updatedAt: "2026-01-05T00:00:00.000Z",
          mergedAt: "2026-01-05T00:00:00.000Z",
        };
        yield* evaluate;

        const task = yield* readTask;
        expect(task.mergedAt).toBe("2026-01-05T00:00:00.000Z");
        expect(task.pullRequest?.state).toBe("merged");
        expect(task.archivedAt).toBeNull();
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.exists(workspacePath)).toBe(true);
        expect((yield* ledgerRows).map((row) => row.type)).toContain("pull-request-merged");

        const reads = host.summaryReads;
        addComment(host, "late", "Too late", "2026-01-06T00:00:00.000Z");
        yield* evaluate;
        assert.strictEqual(host.summaryReads, reads);
        assert.strictEqual(yield* Queue.size(created), 0);
      }),
    ),
  );
  it.effect("records a merge made in the app without waiting for the next sweep", () =>
    withTask({ autoHandleReviewFeedback: false }, ({ host, merges }) =>
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const reactor = yield* TaskSupervisorReactor.TaskSupervisorReactor;
        const nextSync = (merged: boolean) =>
          engine.subscribeDomainEvents.pipe(
            Effect.flatMap((events) =>
              events.pipe(
                Stream.filter(
                  (event) =>
                    event.type === "task.meta-updated" &&
                    (merged ? event.payload.mergedAt != null : event.payload.pullRequest != null),
                ),
                Stream.runHead,
              ),
            ),
            Effect.forkScoped,
          );
        // The startup sweep links the open PR; the next sweep is a minute away.
        const linked = yield* nextSync(false);
        yield* reactor.start();
        yield* Fiber.join(linked);
        yield* reactor.drain;

        host.pullRequest = {
          state: "merged",
          updatedAt: "2026-01-05T00:00:00.000Z",
          mergedAt: "2026-01-05T00:00:00.000Z",
        };
        const synced = yield* nextSync(true);
        const task = yield* readTask;
        yield* PubSub.publish(merges, {
          projectId: PROJECT_ID,
          repository: "github.com/owner/repo",
          number: task.pullRequest!.number,
          mergedAt: "2026-01-05T00:00:00.000Z",
        } as PullRequestMergeEvent);
        yield* Fiber.join(synced);
        expect((yield* readTask).mergedAt).toBe("2026-01-05T00:00:00.000Z");
      }),
    ),
  );

  it.effect("links the pull request as soon as setup becomes ready", () =>
    withTask({ autoHandleReviewFeedback: false, setupStatus: "running" }, ({ workspacePath }) =>
      Effect.gen(function* () {
        const reactor = yield* TaskSupervisorReactor.TaskSupervisorReactor;
        const engine = yield* OrchestrationEngineService;
        // Resolves once the task's pull request is synced onto it.
        const linkOf = (taskId: TaskId) =>
          engine.subscribeDomainEvents.pipe(
            Effect.flatMap((events) =>
              events.pipe(
                Stream.filter(
                  (event) =>
                    event.type === "task.meta-updated" &&
                    event.payload.taskId === taskId &&
                    event.payload.pullRequest != null,
                ),
                Stream.runHead,
              ),
            ),
            Effect.forkScoped,
          );
        // A ready sentinel task proves the startup sweep has run, so the
        // link below can only come from the setup-ready event.
        const sentinel = TaskId.make("task-sentinel");
        const task = yield* readTask;
        yield* engine.dispatch({
          type: "task.create",
          commandId: CommandId.make("cmd-task-sentinel"),
          taskId: sentinel,
          projectId: PROJECT_ID,
          title: "Sentinel",
          description: null,
          workspace: {
            ...task.workspace,
            path: workspacePath,
            setup: { ...task.workspace.setup, status: "ready" },
          },
          autoHandleReviewFeedback: false,
          autoHandleCIFailures: false,
          createdAt: CREATED_AT,
        });
        const sentinelLinked = yield* linkOf(sentinel);
        yield* reactor.start();
        yield* Fiber.join(sentinelLinked);
        yield* reactor.drain;
        expect((yield* readTask).pullRequest).toBeNull();

        const linked = yield* linkOf(TASK_ID);
        yield* engine.dispatch({
          type: "task.sync",
          commandId: CommandId.make("cmd-setup-ready"),
          taskId: TASK_ID,
          workspace: {
            ...task.workspace,
            setup: { ...task.workspace.setup, status: "ready" },
          },
        });
        yield* Fiber.join(linked);
        yield* reactor.drain;
        expect((yield* readTask).pullRequest).toMatchObject({ number: 7, state: "open" });
      }),
    ),
  );

  it.effect("records the same pull request comment once per task", () =>
    withTask({ autoHandleReviewFeedback: false }, () =>
      Effect.gen(function* () {
        const ledger = yield* TaskScmEvents.make;
        const row = (id: string, taskId: TaskId) => ({
          id,
          taskId,
          providerEventKey: "github:owner/repo:7:comment:shared",
          type: "review-comment-added",
          payloadJson: "{}",
          observedAt: CREATED_AT,
          state: "pending" as const,
        });
        const otherTask = TaskId.make("task-other");
        yield* ledger.insertIgnore([row("a", TASK_ID), row("b", otherTask)]);
        // Re-observing it for either task is still a no-op.
        yield* ledger.insertIgnore([row("a2", TASK_ID), row("b2", otherTask)]);

        expect((yield* ledger.listByTask(TASK_ID)).map((entry) => entry.id)).toEqual(["a"]);
        expect((yield* ledger.listByTask(otherTask)).map((entry) => entry.id)).toEqual(["b"]);
      }),
    ),
  );
});
