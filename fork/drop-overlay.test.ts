import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

const SCRIPT = NodePath.resolve(import.meta.dirname, "drop-overlay.sh");
const SUBJECT = "chore(brand): apply Merge brand overlay [generated]";

async function repo(t: { after: (fn: () => Promise<void>) => void }, subjects: string[]) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "merge-drop-"));
  t.after(() => NodeFSP.rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync(
      "git",
      ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args],
      { encoding: "utf8" },
    );
  git("init", "-q", "-b", "main");
  await NodeFSP.writeFile(NodePath.join(root, "base.txt"), "base\n");
  git("add", "-A");
  git("commit", "-q", "-m", "upstream");
  git("update-ref", "refs/remotes/upstream/main", "HEAD");
  for (const [index, subject] of subjects.entries()) {
    await NodeFSP.writeFile(NodePath.join(root, `f${index}.txt`), `${subject}\n`);
    git("add", "-A");
    git("commit", "-q", "-m", subject);
  }
  return { root, git };
}

function run(root: string) {
  // The script's rebase commits; CI runners have no git identity of their own.
  const identity = { GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  return NodeChildProcess.spawnSync(SCRIPT, ["upstream/main"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...identity },
  });
}

NodeTest.test("drops an overlay commit that sits below a release commit", async (t) => {
  const { root, git } = await repo(t, ["feat: a", SUBJECT, "chore(release): prepare v1"]);
  NodeAssert.equal(run(root).status, 0);
  NodeAssert.deepEqual(git("log", "--format=%s", "upstream/main..HEAD").trim().split("\n"), [
    "chore(release): prepare v1",
    "feat: a",
  ]);
});

NodeTest.test("does nothing without an overlay commit", async (t) => {
  const { root, git } = await repo(t, ["feat: a"]);
  NodeAssert.equal(run(root).status, 0);
  NodeAssert.equal(git("log", "--format=%s", "upstream/main..HEAD").trim(), "feat: a");
});

NodeTest.test("refuses when more than one overlay commit exists", async (t) => {
  const { root, git } = await repo(t, [SUBJECT, "feat: a", SUBJECT]);
  const result = run(root);
  NodeAssert.equal(result.status, 1);
  NodeAssert.match(result.stderr, /found 2 generated brand commits/);
  NodeAssert.equal(git("log", "--format=%s", "upstream/main..HEAD").trim().split("\n").length, 3);
});
