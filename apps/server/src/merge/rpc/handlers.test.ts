// @effect-diagnostics nodeBuiltinImport:off - fixture repo setup runs before the layer is built.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  MERGE_WS_METHODS,
  MergeRpcGroup,
  RpcScopeAuthorization,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ThreadId, WorkTaskId, WorkTaskOperationError } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { Headers } from "effect/http";
import { RpcMessage, RpcServer } from "effect/rpc";

import * as RpcAuthorization from "../../auth/RpcAuthorization.ts";
import * as ServerConfig from "../../config.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as VcsProjectConfig from "../../vcs/VcsProjectConfig.ts";
import * as KnownWorkspaces from "../../workspace/KnownWorkspaces.ts";
import { WS_RPC_SERVER_OPTIONS } from "../../ws.ts";
import * as FolderStore from "../folders/FolderStore.ts";
import * as WorkTaskStore from "../workTasks/WorkTaskStore.ts";
import * as WorkTaskWorkspace from "../workTasks/WorkTaskWorkspace.ts";
import { mergeRpcHandlers } from "./handlers.ts";

const ping = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  Effect.gen(function* () {
    const responses = yield* Queue.unbounded<Exit.Exit<unknown, unknown>>();
    const server = yield* RpcServer.makeNoSerialization(
      MergeRpcGroup.middleware(RpcScopeAuthorization),
      {
        ...WS_RPC_SERVER_OPTIONS,
        onFromServer: (response) =>
          response._tag === "Exit" ? Queue.offer(responses, response.exit) : Effect.void,
      },
    ).pipe(
      Effect.provide(
        Layer.mergeAll(MergeRpcGroup.toLayer(mergeRpcHandlers), RpcAuthorization.layer(scopes)),
      ),
    );
    yield* server.write(0, {
      _tag: "Request",
      id: RpcMessage.RequestId("ping"),
      tag: MERGE_WS_METHODS.ping,
      payload: {},
      headers: Headers.empty,
    });
    return yield* Queue.take(responses);
  }).pipe(Effect.scoped);

it.effect("merge.ping succeeds with the orchestration read scope", () =>
  Effect.gen(function* () {
    const exit = yield* ping([AuthOrchestrationReadScope]);
    assert.isTrue(Exit.isSuccess(exit));
    if (Exit.isSuccess(exit)) assert.deepEqual(exit.value, { pong: true });
  }),
);

it.effect("merge.ping fails without any scope", () =>
  Effect.gen(function* () {
    assert.isTrue(Exit.isFailure(yield* ping([])));
  }),
);

// The services the server's `layerVcs`/`layerReview` compose, built from the production layers
// with only the project list and settings stubbed.
const productionLayers = (projectRoot: string) =>
  KnownWorkspaces.layer.pipe(
    Layer.provideMerge(
      VcsDriverRegistry.layer.pipe(
        Layer.provide(VcsProjectConfig.layer),
        Layer.provide(VcsProcess.layer),
      ),
    ),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        listShells: () =>
          Effect.succeed([
            {
              id: ProjectId.make("project-0"),
              title: "Project",
              workspaceRoot: projectRoot,
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ]),
      }),
    ),
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(ServerSettings.ServerSettingsService.layerTest({})),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-merge-rpc-" })),
    Layer.provideMerge(NodeServices.layer),
  );

const gitGraphLogViaRpc = (
  cwd: string,
  projectRoot: string,
  scopes: ReadonlyArray<AuthEnvironmentScope> = [AuthFilesystemReadScope],
) =>
  Effect.gen(function* () {
    const responses = yield* Queue.unbounded<Exit.Exit<unknown, unknown>>();
    const server = yield* RpcServer.makeNoSerialization(
      MergeRpcGroup.middleware(RpcScopeAuthorization),
      {
        ...WS_RPC_SERVER_OPTIONS,
        onFromServer: (response) =>
          response._tag === "Exit" ? Queue.offer(responses, response.exit) : Effect.void,
      },
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          MergeRpcGroup.toLayer(mergeRpcHandlers),
          RpcAuthorization.layer(scopes),
        ).pipe(Layer.provideMerge(productionLayers(projectRoot))),
      ),
    );
    yield* server.write(0, {
      _tag: "Request",
      id: RpcMessage.RequestId("git-graph"),
      tag: MERGE_WS_METHODS.gitGraphLog,
      payload: { cwd },
      headers: Headers.empty,
    });
    return yield* Queue.take(responses);
  }).pipe(Effect.scoped);

it.effect("merge.gitGraph.log finds its services through the RPC path", () =>
  Effect.gen(function* () {
    const root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "merge-rpc-")),
    );
    const git = (...args: string[]) =>
      NodeChildProcess.execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.com");
    git("config", "user.name", "T");
    git("commit", "-q", "--allow-empty", "-m", "root");
    git("checkout", "-q", "-b", "feature/rpc");
    git("commit", "-q", "--allow-empty", "-m", "on feature");

    // Registered as a project, but outside the server's cwd, so only KnownWorkspaces admits it.
    const known = yield* gitGraphLogViaRpc(root, root);
    assert.isTrue(Exit.isSuccess(known));
    if (Exit.isSuccess(known)) {
      const log = known.value as { headRef: string; commits: ReadonlyArray<{ subject: string }> };
      assert.equal(log.headRef, "feature/rpc");
      assert.deepEqual(
        log.commits.map((commit) => commit.subject),
        ["on feature"],
      );
    }

    const elsewhere = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "merge-rpc-other-"));
    assert.isTrue(Exit.isFailure(yield* gitGraphLogViaRpc(elsewhere, root)));

    // The read scope is what authorizes it.
    assert.isTrue(Exit.isFailure(yield* gitGraphLogViaRpc(root, root, [])));
  }),
);

it.effect("merge.workItems writes need the source-control write scope", () =>
  Effect.gen(function* () {
    const update = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
      Effect.gen(function* () {
        const responses = yield* Queue.unbounded<Exit.Exit<unknown, unknown>>();
        const server = yield* RpcServer.makeNoSerialization(
          MergeRpcGroup.middleware(RpcScopeAuthorization),
          {
            ...WS_RPC_SERVER_OPTIONS,
            onFromServer: (response) =>
              response._tag === "Exit" ? Queue.offer(responses, response.exit) : Effect.void,
          },
        ).pipe(
          Effect.provide(
            Layer.mergeAll(MergeRpcGroup.toLayer(mergeRpcHandlers), RpcAuthorization.layer(scopes)),
          ),
        );
        yield* server.write(0, {
          _tag: "Request",
          id: RpcMessage.RequestId("work-item"),
          tag: MERGE_WS_METHODS.workItemsUpdate,
          payload: { cwd: "/nowhere", id: 1, state: "Done" },
          headers: Headers.empty,
        });
        return yield* Queue.take(responses);
      }).pipe(Effect.scoped);

    const denied = yield* update([AuthOrchestrationReadScope]);
    assert.isTrue(Exit.isFailure(denied));
    assert.include(
      String(Exit.isFailure(denied) ? denied.cause : ""),
      "EnvironmentAuthorizationError",
    );
  }),
);

const workTasksLayer = WorkTaskStore.layer.pipe(
  Layer.provideMerge(
    Layer.effectDiscard(runMigrations()).pipe(
      Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("merge.workTasks.subscribe streams the snapshot, then again after a change", () =>
  Effect.gen(function* () {
    const store = yield* WorkTaskStore.WorkTaskStore;
    const subscribe = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
      Effect.gen(function* () {
        const messages = yield* Queue.unbounded<RpcMessage.FromServer<never>>();
        const server = yield* RpcServer.makeNoSerialization(
          MergeRpcGroup.middleware(RpcScopeAuthorization),
          { ...WS_RPC_SERVER_OPTIONS, onFromServer: (message) => Queue.offer(messages, message) },
        ).pipe(
          Effect.provide(
            Layer.mergeAll(MergeRpcGroup.toLayer(mergeRpcHandlers), RpcAuthorization.layer(scopes)),
          ),
        );
        const requestId = RpcMessage.RequestId("work-tasks");
        yield* server.write(0, {
          _tag: "Request",
          id: requestId,
          tag: MERGE_WS_METHODS.workTasksSubscribe,
          payload: {},
          headers: Headers.empty,
        });
        const next = Effect.gen(function* () {
          const message = yield* Queue.take(messages);
          if (message._tag === "Chunk") yield* server.write(0, { _tag: "Ack", requestId });
          return message;
        });
        return { next };
      });

    yield* Effect.scoped(
      Effect.gen(function* () {
        const { next } = yield* subscribe([AuthOrchestrationReadScope]);
        const first = yield* next;
        assert.strictEqual(first._tag, "Chunk");
        if (first._tag === "Chunk") {
          assert.deepStrictEqual(first.values, [{ tasks: [], links: [] }]);
        }
        yield* store.link(ThreadId.make("thread-a"), WorkTaskId.make("task-1"), "user");
        const second = yield* next;
        assert.strictEqual(second._tag, "Chunk");
        if (second._tag === "Chunk") {
          assert.deepStrictEqual(second.values.at(-1), {
            tasks: [],
            links: [{ threadId: "thread-a", taskId: "task-1", origin: "user" }],
          });
        }
      }),
    );

    // Upstream's shell subscriptions need the orchestration read scope; so does this one.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { next } = yield* subscribe([]);
        const denied = yield* next;
        assert.strictEqual(denied._tag, "Exit");
        if (denied._tag === "Exit") assert.isTrue(Exit.isFailure(denied.exit));
      }),
    );
  }).pipe(Effect.provide(workTasksLayer)),
);

it.effect(
  "merge.workTasks actions reach WorkTaskWorkspace through the RPC path with the operate scope",
  () =>
    Effect.gen(function* () {
      const calls: Array<unknown> = [];
      const actions = Layer.mock(WorkTaskWorkspace.WorkTaskWorkspace)({
        setWaiting: (input) => Effect.sync(() => void calls.push(input)),
        archive: () =>
          Effect.fail(
            new WorkTaskOperationError({
              reason: "archive-blocked",
              message: "Archiving would lose work: agent-running.",
              blockers: ["agent-running"],
            }),
          ),
      });
      const call = (
        tag: (typeof MERGE_WS_METHODS)[keyof typeof MERGE_WS_METHODS],
        payload: object,
        scopes: ReadonlyArray<AuthEnvironmentScope>,
      ) =>
        Effect.gen(function* () {
          const responses = yield* Queue.unbounded<Exit.Exit<unknown, unknown>>();
          const server = yield* RpcServer.makeNoSerialization(
            MergeRpcGroup.middleware(RpcScopeAuthorization),
            {
              ...WS_RPC_SERVER_OPTIONS,
              onFromServer: (response) =>
                response._tag === "Exit" ? Queue.offer(responses, response.exit) : Effect.void,
            },
          ).pipe(
            Effect.provide(
              Layer.mergeAll(
                MergeRpcGroup.toLayer(mergeRpcHandlers),
                RpcAuthorization.layer(scopes),
              ),
            ),
          );
          yield* server.write(0, {
            _tag: "Request",
            id: RpcMessage.RequestId("work-task"),
            tag,
            payload,
            headers: Headers.empty,
          });
          return yield* Queue.take(responses);
        }).pipe(Effect.scoped, Effect.provide(actions));

      const taskId = WorkTaskId.make("task-1");
      const waiting = yield* call(
        MERGE_WS_METHODS.workTasksSetWaiting,
        { taskId, reason: "Pick a base" },
        [AuthOrchestrationOperateScope],
      );
      assert.isTrue(Exit.isSuccess(waiting));
      assert.deepStrictEqual(calls, [{ taskId, reason: "Pick a base" }]);

      const blocked = yield* call(MERGE_WS_METHODS.workTasksArchive, { taskId }, [
        AuthOrchestrationOperateScope,
      ]);
      assert.include(
        String(Exit.isFailure(blocked) ? blocked.cause : ""),
        "WorkTaskOperationError",
      );

      // Every mutation needs more than the read scope.
      for (const tag of [
        MERGE_WS_METHODS.workTasksCreate,
        MERGE_WS_METHODS.workTasksRetrySetup,
        MERGE_WS_METHODS.workTasksCreateThread,
        MERGE_WS_METHODS.workTasksArchive,
        MERGE_WS_METHODS.workTasksSetWaiting,
        MERGE_WS_METHODS.workTasksSetAutoHandle,
      ]) {
        const denied = yield* call(tag, { taskId, reason: null }, [AuthOrchestrationReadScope]);
        assert.include(
          String(Exit.isFailure(denied) ? denied.cause : ""),
          "EnvironmentAuthorizationError",
          tag,
        );
      }
      assert.strictEqual(calls.length, 1);
    }),
);

const foldersLayer = FolderStore.layer.pipe(
  Layer.provideMerge(
    Layer.effectDiscard(runMigrations()).pipe(
      Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("merge.folders mutations need the operate scope and reach subscribers", () =>
  Effect.gen(function* () {
    const open = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
      Effect.gen(function* () {
        const messages = yield* Queue.unbounded<RpcMessage.FromServer<never>>();
        const server = yield* RpcServer.makeNoSerialization(
          MergeRpcGroup.middleware(RpcScopeAuthorization),
          { ...WS_RPC_SERVER_OPTIONS, onFromServer: (message) => Queue.offer(messages, message) },
        ).pipe(
          Effect.provide(
            Layer.mergeAll(MergeRpcGroup.toLayer(mergeRpcHandlers), RpcAuthorization.layer(scopes)),
          ),
        );
        let nextId = 0;
        const send = (
          tag: (typeof MERGE_WS_METHODS)[keyof typeof MERGE_WS_METHODS],
          payload: object,
        ) => {
          const id = RpcMessage.RequestId(`folders-${nextId++}`);
          return server
            .write(0, { _tag: "Request", id, tag, payload, headers: Headers.empty })
            .pipe(Effect.as(id));
        };
        const next = Effect.gen(function* () {
          const message = yield* Queue.take(messages);
          if (message._tag === "Chunk") {
            yield* server.write(0, { _tag: "Ack", requestId: message.requestId });
          }
          return message;
        });
        const call = (
          tag: (typeof MERGE_WS_METHODS)[keyof typeof MERGE_WS_METHODS],
          payload: object,
        ) =>
          Effect.gen(function* () {
            yield* send(tag, payload);
            const message = yield* next;
            assert.strictEqual(message._tag, "Exit");
            return message._tag === "Exit" ? message.exit : Exit.void;
          });
        return { send, next, call };
      });

    yield* Effect.scoped(
      Effect.gen(function* () {
        const reader = yield* open([AuthOrchestrationReadScope]);
        for (const [tag, payload] of [
          [MERGE_WS_METHODS.foldersCreate, { title: "Later" }],
          [MERGE_WS_METHODS.foldersRename, { folderId: "f", title: "x" }],
          [MERGE_WS_METHODS.foldersDelete, { folderId: "f" }],
          [MERGE_WS_METHODS.foldersAssign, { threadId: "t", folderId: null }],
        ] as const) {
          const denied = yield* reader.call(tag, payload);
          assert.include(
            String(Exit.isFailure(denied) ? denied.cause : ""),
            "EnvironmentAuthorizationError",
            tag,
          );
        }
        // Subscribing needs only the read scope.
        yield* reader.send(MERGE_WS_METHODS.foldersSubscribe, {});
        const first = yield* reader.next;
        assert.deepStrictEqual(first._tag === "Chunk" ? first.values : null, [
          { folders: [], links: [] },
        ]);

        const writer = yield* open([AuthOrchestrationOperateScope]);
        const created = yield* writer.call(MERGE_WS_METHODS.foldersCreate, { title: "Later" });
        assert.isTrue(Exit.isSuccess(created));
        const folderId = Exit.isSuccess(created)
          ? (created.value as unknown as { folderId: string }).folderId
          : "";
        assert.isTrue(
          Exit.isSuccess(
            yield* writer.call(MERGE_WS_METHODS.foldersAssign, { threadId: "t", folderId }),
          ),
        );
        const missing = yield* writer.call(MERGE_WS_METHODS.foldersAssign, {
          threadId: "t",
          folderId: "nope",
        });
        assert.include(
          String(Exit.isFailure(missing) ? missing.cause : ""),
          "FolderOperationError",
        );

        // Writes coalesce in the sliding PubSub; the latest snapshot holds both.
        let latest: unknown = null;
        while (
          JSON.stringify(latest) !==
          JSON.stringify({
            folders: [{ id: folderId, title: "Later" }],
            links: [{ threadId: "t", folderId }],
          })
        ) {
          const chunk = yield* reader.next;
          const value = chunk._tag === "Chunk" ? chunk.values.at(-1) : null;
          const snapshot = value as {
            folders: ReadonlyArray<{ id: string; title: string }>;
            links: unknown;
          };
          latest = {
            folders: snapshot.folders.map(({ id, title }) => ({ id, title })),
            links: snapshot.links,
          };
        }
      }),
    );
  }).pipe(Effect.provide(foldersLayer)),
);
