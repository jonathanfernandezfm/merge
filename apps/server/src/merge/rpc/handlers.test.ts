import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  MERGE_WS_METHODS,
  MergeRpcGroup,
  RpcScopeAuthorization,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { Headers } from "effect/http";
import { RpcMessage, RpcServer } from "effect/rpc";

import * as RpcAuthorization from "../../auth/RpcAuthorization.ts";
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
