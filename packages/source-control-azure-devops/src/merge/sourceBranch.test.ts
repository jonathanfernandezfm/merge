import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as AzureDevOpsCli from "../server/AzureDevOpsCli.ts";

it.effect("passes a branch with a # to az encoded, so the query string keeps it", () => {
  const run = vi.fn<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>(() =>
    Effect.succeed({
      exitCode: ChildProcessSpawner.ExitCode(0),
      stdout: "[]",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    }),
  );
  const support = Layer.mergeAll(
    TestSourceControlHost.layer({ process: { run } }),
    NodeServices.layer,
  );
  return Effect.gen(function* () {
    const az = yield* AzureDevOpsCli.AzureDevOpsCli;
    yield* az.listPullRequests({ cwd: "/repo", headSelector: "feature/#123-x", state: "open" });
    const args = run.mock.calls[0]?.[0].args ?? [];
    assert.strictEqual(args[args.indexOf("--source-branch") + 1], "feature%2F%23123-x");
  }).pipe(Effect.provide(AzureDevOpsCli.layer.pipe(Layer.provide(support))));
});
