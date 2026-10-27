// @effect-diagnostics nodeBuiltinImport:off - fixture files and the socket are set up outside Effect.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { applyCopyRule, readCopyRules } from "./copyRules.ts";

const fixture = () => {
  const dir = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "merge-cp-")));
  const root = NodePath.join(dir, "root");
  const worktree = NodePath.join(dir, "wt");
  NodeFS.mkdirSync(root);
  NodeFS.mkdirSync(worktree);
  const write = (file: string, text: string) => {
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, text);
  };
  return { dir, root, worktree, write };
};

it.effect("readCopyRules reads only workspace.copy from t3.json", () =>
  Effect.gen(function* () {
    const { dir, root, write } = fixture();
    assert.deepStrictEqual(yield* readCopyRules(root), []);
    write(
      NodePath.join(root, "t3.json"),
      JSON.stringify({
        scripts: [{ name: "setup", command: "vp i" }],
        workspace: { copy: [{ from: ".env.local", required: true }] },
      }),
    );
    assert.deepStrictEqual(yield* readCopyRules(root), [{ from: ".env.local", required: true }]);
    // A broken rule must not silently drop a required copy.
    write(NodePath.join(root, "t3.json"), JSON.stringify({ workspace: { copy: [{ to: "x" }] } }));
    assert.strictEqual((yield* Effect.flip(readCopyRules(root))).reason, "failed");
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("applyCopyRule copies, keeps, overwrites and refuses as configured", () =>
  Effect.gen(function* () {
    const { dir, root, worktree, write } = fixture();
    const apply = (rule: Parameters<typeof applyCopyRule>[2]) =>
      applyCopyRule(root, worktree, rule);

    assert.strictEqual((yield* apply({ from: ".env", required: true })).status, "failed");
    assert.strictEqual((yield* apply({ from: ".env" })).status, "skipped");

    write(NodePath.join(root, ".env"), "SECRET=1\n");
    assert.strictEqual((yield* apply({ from: ".env" })).status, "done");
    assert.strictEqual(NodeFS.readFileSync(NodePath.join(worktree, ".env"), "utf8"), "SECRET=1\n");

    write(NodePath.join(root, ".env"), "SECRET=2\n");
    assert.strictEqual((yield* apply({ from: ".env" })).status, "skipped");
    assert.strictEqual(NodeFS.readFileSync(NodePath.join(worktree, ".env"), "utf8"), "SECRET=1\n");
    assert.strictEqual((yield* apply({ from: ".env", overwrite: true })).status, "done");
    assert.strictEqual(NodeFS.readFileSync(NodePath.join(worktree, ".env"), "utf8"), "SECRET=2\n");

    assert.strictEqual((yield* apply({ from: "../outside" })).status, "failed");
    assert.strictEqual((yield* apply({ from: ".env", to: "../escape" })).status, "failed");

    // A live daemon socket inside a copied directory is skipped, not a failure.
    write(NodePath.join(root, "config", "nested", "app.json"), "{}\n");
    const daemon = NodeNet.createServer().unref();
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve) =>
          daemon.listen(NodePath.join(root, "config", "daemon.sock"), resolve),
        ),
    );
    assert.strictEqual((yield* apply({ from: "config", to: "settings" })).status, "done");
    assert.isTrue(NodeFS.existsSync(NodePath.join(worktree, "settings", "nested", "app.json")));
    assert.isFalse(NodeFS.existsSync(NodePath.join(worktree, "settings", "daemon.sock")));
    daemon.close();
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("applyCopyRule refuses paths that escape through symlinks", () =>
  Effect.gen(function* () {
    const { dir, root, worktree, write } = fixture();
    const outside = NodePath.join(dir, "outside");
    write(NodePath.join(outside, "secret"), "outside\n");
    write(NodePath.join(root, ".env"), "SECRET=1\n");
    const apply = (rule: Parameters<typeof applyCopyRule>[2]) =>
      applyCopyRule(root, worktree, rule);

    // Source side: a symlinked parent directory that leaves the project.
    NodeFS.symlinkSync(outside, NodePath.join(root, "linked"));
    assert.strictEqual((yield* apply({ from: "linked/secret" })).status, "failed");

    // Destination side: a symlinked parent directory that leaves the worktree.
    NodeFS.symlinkSync(outside, NodePath.join(worktree, "out"));
    assert.strictEqual((yield* apply({ from: ".env", to: "out/.env" })).status, "failed");
    assert.isFalse(NodeFS.existsSync(NodePath.join(outside, ".env")));

    // A destination that is itself a symlink is never removed or written through.
    NodeFS.symlinkSync(NodePath.join(outside, "secret"), NodePath.join(worktree, ".env"));
    assert.strictEqual((yield* apply({ from: ".env", overwrite: true })).status, "failed");
    assert.strictEqual(NodeFS.readFileSync(NodePath.join(outside, "secret"), "utf8"), "outside\n");
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);
