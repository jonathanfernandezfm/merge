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
  Layer.mock(KnownWorkspaces.KnownWorkspaces)({ contains: () => Effect.succeed(true) }),
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-git-graph-test-" }),
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

  const initRepo = (cwd: string) =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* driver.initRepo({ cwd });
      yield* git(cwd, ["config", "user.email", "test@test.com"]);
      yield* git(cwd, ["config", "user.name", "Test"]);
    });
  const commit = (cwd: string, file: string, message: string) =>
    Effect.gen(function* () {
      yield* write(cwd, file, `${message}\n`);
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "-m", message]);
      return yield* git(cwd, ["rev-parse", "HEAD"]);
    });

  it.effect("prefers the branch's recorded t3-merge-base-ref over a stale local base", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "git-graph-config-" });
      yield* initRepo(cwd);
      const rootSha = yield* commit(cwd, "root.txt", "root");
      const main = yield* git(cwd, ["symbolic-ref", "--short", "HEAD"]);
      const remoteTip = yield* commit(cwd, "remote.txt", "remote work");
      yield* git(cwd, ["checkout", "-b", "feature/x"]);
      yield* commit(cwd, "feature.txt", "feature work");
      // Local main is behind the remote-tracking ref the branch was cut from.
      yield* git(cwd, ["branch", "-f", main, rootSha]);
      yield* git(cwd, ["update-ref", "refs/remotes/origin/main", remoteTip]);

      const stale = yield* gitGraphLog({ cwd });
      assert.equal(stale.baseRef, main);
      assert.equal(stale.commits.length, 2);

      yield* git(cwd, ["config", "branch.feature/x.t3-merge-base-ref", "refs/remotes/origin/main"]);
      const recorded = yield* gitGraphLog({ cwd });
      assert.equal(recorded.baseRef, "origin/main");
      assert.equal(recorded.mergeBase, remoteTip);
      assert.deepStrictEqual(
        recorded.commits.map((entry) => entry.subject),
        ["feature work"],
      );

      // Only full refs count, and a dangling one falls through to the normal candidates.
      yield* git(cwd, ["config", "branch.feature/x.t3-merge-base-ref", "refs/remotes/origin/gone"]);
      assert.equal((yield* gitGraphLog({ cwd })).baseRef, main);
    }),
  );

  it.effect("rejects option-like revisions and unknown workspaces", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "git-graph-reject-" });
      yield* initRepo(cwd);
      yield* commit(cwd, "a.txt", "a");
      const badBase = yield* gitGraphLog({ cwd, baseRef: "--output=x" }).pipe(Effect.flip);
      assert.equal(badBase._tag, "GitCommandError");

      const unknown = Effect.provideService(KnownWorkspaces.KnownWorkspaces, {
        contains: () => Effect.succeed(false),
        assertContains: () => Effect.void,
      });
      const log = yield* gitGraphLog({ cwd }).pipe(unknown, Effect.flip);
      assert.equal(log._tag, "VcsRepositoryDetectionError");
      const diff = yield* gitGraphCommitDiff({ cwd, sha: "abcd" }).pipe(unknown, Effect.flip);
      assert.equal(diff._tag, "VcsRepositoryDetectionError");
    }),
  );
});
