// @effect-diagnostics nodeBuiltinImport:off -- Makes a temp workspace for the cwd guard.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as SourceControlProviderRegistry from "../../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as KnownWorkspaces from "../../workspace/KnownWorkspaces.ts";
import { requeueExpiredChecks } from "./requeueExpiredChecks.ts";

const POLICIES = JSON.stringify([
  { evaluationId: "e1", status: "queued", context: { isExpired: true } },
  { evaluationId: "e2", status: "approved", context: { isExpired: false } },
  { evaluationId: "e3", status: "running", context: { isExpired: true } },
]);

function harness(kind = "azure-devops") {
  const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "merge-rq-")));
  const az: Array<ReadonlyArray<string>> = [];
  const layer = Layer.mergeAll(
    Layer.mock(VcsProcess.VcsProcess)({
      run: (input) => {
        az.push(input.args);
        return Effect.succeed({
          exitCode: 0 as never,
          stdout: input.args.includes("list") ? POLICIES : "{}",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      },
    }),
    Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
      resolveLink: () => undefined,
      resolve: () =>
        Effect.succeed({
          kind: SourceControlProviderKind.make(kind),
        } as unknown as SourceControlProviderRegistry.SourceControlProviderRegistration["provider"]),
    }),
    Layer.mock(KnownWorkspaces.KnownWorkspaces)({ contains: () => Effect.succeed(false) }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(root, { prefix: "t3-merge-rq-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  return { root, az, layer };
}

it.effect("queues each expired evaluation again, and only those", () => {
  const h = harness();
  return Effect.gen(function* () {
    const result = yield* requeueExpiredChecks({ cwd: h.root, number: 42 });
    assert.deepStrictEqual(result, { queued: 2 });
    assert.deepStrictEqual(
      h.az.filter((args) => args.includes("queue")).map((args) => args.slice(0, 9)),
      [
        ["repos", "pr", "policy", "queue", "--detect", "true", "--id", "42", "--evaluation-id=e1"],
        ["repos", "pr", "policy", "queue", "--detect", "true", "--id", "42", "--evaluation-id=e3"],
      ],
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect("refuses outside Azure DevOps and outside known workspaces without calling az", () =>
  Effect.gen(function* () {
    const github = harness("github");
    const notAzure = yield* Effect.flip(
      requeueExpiredChecks({ cwd: github.root, number: 42 }).pipe(Effect.provide(github.layer)),
    );
    assert.include(String(notAzure), "This needs an Azure DevOps repository.");
    assert.deepStrictEqual(github.az, []);

    const h = harness();
    const elsewhere = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "merge-rq-other-"));
    yield* Effect.flip(
      requeueExpiredChecks({ cwd: elsewhere, number: 42 }).pipe(Effect.provide(h.layer)),
    );
    yield* Effect.flip(
      requeueExpiredChecks({ cwd: h.root, number: 0 }).pipe(Effect.provide(h.layer)),
    );
    assert.deepStrictEqual(h.az, []);
  }),
);
