// @effect-diagnostics nodeBuiltinImport:off - fixture repo setup runs before the layer is built.
import * as NodeChild from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import {
  AuthFilesystemReadScope,
  AuthOrchestrationReadScope,
  MERGE_WS_METHODS,
  MergeRpcGroup,
  RpcScopeAuthorization,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { Headers } from "effect/http";
import { RpcMessage, RpcServer } from "effect/rpc";

import * as RpcAuthorization from "../../auth/RpcAuthorization.ts";
import * as ServerConfig from "../../config.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as VcsProjectConfig from "../../vcs/VcsProjectConfig.ts";
import * as KnownWorkspaces from "../../workspace/KnownWorkspaces.ts";
import { WS_RPC_SERVER_OPTIONS } from "../../ws.ts";
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
      NodeChild.execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
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
