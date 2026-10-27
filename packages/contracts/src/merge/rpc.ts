import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import { EnvironmentAuthorizationError } from "../auth.ts";

export const MERGE_WS_METHODS = {
  ping: "merge.ping",
} as const;

export const MergePingRpc = Rpc.make(MERGE_WS_METHODS.ping, {
  payload: Schema.Struct({}),
  success: Schema.Struct({ pong: Schema.Literal(true) }),
  error: EnvironmentAuthorizationError,
});

/** Fork RPCs. Merged into `WsRpcGroup` at the `rpc-group` seam. */
export const MergeRpcGroup = RpcGroup.make(MergePingRpc);
