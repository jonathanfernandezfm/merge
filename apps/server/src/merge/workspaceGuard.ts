import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";

/**
 * Looks the service up when a request runs instead of in the handler's type, so the fork RPC
 * handlers add no requirements to upstream's WS test harnesses. The server layer always has them.
 */
export const lookup = <I, S>(key: Context.Key<I, S>) =>
  Effect.serviceOption(key).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.die(new Error(`Merge: ${key.key} is not provided.`)),
        onSome: Effect.succeed,
      }),
    ),
  );

/**
 * Fails with `reject` unless `cwd` is inside the server's workspace root or a known workspace,
 * the same rule as ReviewService. Client-sent cwds pass through here before any process runs.
 */
export const requireKnownWorkspace = Effect.fn("Merge.requireKnownWorkspace")(function* <E>(
  cwd: string,
  reject: (cause?: unknown) => E,
) {
  const known = yield* lookup(KnownWorkspaces.KnownWorkspaces);
  const config = yield* lookup(ServerConfig.ServerConfig);
  const fileSystem = yield* lookup(FileSystem.FileSystem);
  const path = yield* lookup(Path.Path);
  const realCwd = yield* fileSystem.realPath(path.resolve(cwd)).pipe(Effect.mapError(reject));
  const realRoot = yield* fileSystem
    .realPath(path.resolve(config.cwd))
    .pipe(Effect.orElseSucceed(() => path.resolve(config.cwd)));
  if (!KnownWorkspaces.isWithinRoot(path, realCwd, realRoot) && !(yield* known.contains(realCwd))) {
    return yield* Effect.fail(reject());
  }
});
