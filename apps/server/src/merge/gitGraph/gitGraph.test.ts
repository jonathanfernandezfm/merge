import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as KnownWorkspaces from "../../workspace/KnownWorkspaces.ts";
import { gitGraphCommitDiff, gitGraphLog } from "./gitGraph.ts";

const TestLayer = Layer.mergeAll(
  Layer.mock(KnownWorkspaces.KnownWorkspaces)({ assertContains: () => Effect.void }),
  Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
    detect: () => Effect.succeed({ kind: "git" } as never),
  }),
  GitVcsDriver.layer.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-git-graph-test-" })),
  ),
).pipe(Layer.provideMerge(NodeServices.layer));

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({ operation: "test.git", cwd, args, timeoutMs: 10_000 });
    return result.stdout.trim();
  });

const write = (cwd: string, name: string, contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(path.join(cwd, name), contents);
  });

it.layer(TestLayer)("git graph", (it) => {
  it.effect("lists branch-only commits and diffs each against its parent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "git-graph-" });
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* driver.initRepo({ cwd });
      yield* git(cwd, ["config", "user.email", "test@test.com"]);
      yield* git(cwd, ["config", "user.name", "Test"]);
      yield* write(cwd, "README.md", "# test\n");
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "-m", "root"]);
      const initialBranch = yield* git(cwd, ["symbolic-ref", "--short", "HEAD"]);
      const rootSha = yield* git(cwd, ["rev-parse", "HEAD"]);
      yield* git(cwd, ["checkout", "-b", "feature/graph"]);
      yield* write(cwd, "a.txt", "one\n");
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "-m", "add a", "-m", "with a body\n\nand\x1fodd bytes"]);
      yield* write(cwd, "a.txt", "one\ntwo\n");
      yield* write(cwd, "b.txt", "b\n");
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "-m", "extend a, add b"]);
      yield* write(cwd, "dirty.txt", "not committed\n");

      const listed = yield* gitGraphLog({ cwd, baseRef: initialBranch });
      assert.equal(listed.mergeBase, rootSha);
      assert.equal(listed.headRef, "feature/graph");
      assert.deepStrictEqual(
        listed.commits.map((commit) => commit.subject),
        ["extend a, add b", "add a"],
      );
      assert.equal(listed.commits[1]!.body, "with a body\n\nand\x1fodd bytes");
      assert.deepStrictEqual(listed.commits[1]!.parents, [rootSha]);
      assert.include(listed.commits[0]!.refs, "feature/graph");
      assert.isFalse(listed.truncated);

      const automatic = yield* gitGraphLog({ cwd });
      assert.equal(automatic.baseRef, initialBranch);
      assert.equal(automatic.commits.length, 2);

      const limited = yield* gitGraphLog({ cwd, baseRef: initialBranch, limit: 1 });
      assert.equal(limited.commits.length, 1);
      assert.isTrue(limited.truncated);

      const tip = yield* gitGraphCommitDiff({ cwd, sha: listed.commits[0]!.sha });
      assert.equal(tip.parentSha, listed.commits[1]!.sha);
      assert.deepInclude(tip, { fileCount: 2, additions: 2, deletions: 0, truncated: false });
      assert.include(tip.diff, "+two");
      // A commit view never mixes in uncommitted work.
      assert.notInclude(tip.diff, "dirty.txt");

      const root = yield* gitGraphCommitDiff({ cwd, sha: rootSha });
      assert.isNull(root.parentSha);
      assert.deepInclude(root, { fileCount: 1, additions: 1 });
      assert.include(root.diff, "README.md");

      const bad = yield* gitGraphCommitDiff({ cwd, sha: "--output=x" }).pipe(Effect.flip);
      assert.equal(bad._tag, "GitCommandError");
    }),
  );
});
