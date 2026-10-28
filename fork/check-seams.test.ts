import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import * as NodeChildProcess from "node:child_process";

import { checkBaseline, checkSeams } from "./check-seams.ts";

async function fixture(t: { after: (fn: () => Promise<void>) => void }, serverSource: string) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "merge-seams-"));
  t.after(() => NodeFSP.rm(root, { recursive: true, force: true }));
  await NodeFSP.mkdir(NodePath.join(root, "fork"), { recursive: true });
  await NodeFSP.mkdir(NodePath.join(root, "apps/server/src"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(root, "fork/seams.json"),
    JSON.stringify([{ id: "server-layer", file: "apps/server/src/server.ts", purpose: "layer" }]),
  );
  await NodeFSP.writeFile(NodePath.join(root, "apps/server/src/server.ts"), serverSource);
  return root;
}

NodeTest.test("a present seam marker is not reported", async (t) => {
  const root = await fixture(
    t,
    "Layer.mergeAll(\n  MergeServerLayer, // merge-seam: server-layer\n",
  );
  NodeAssert.deepEqual(await checkSeams(root), { missing: [] });
});

NodeTest.test("a YAML # seam marker is recognised", async (t) => {
  const root = await fixture(t, "# merge-seam: server-layer\nname: CI\n");
  NodeAssert.deepEqual(await checkSeams(root), { missing: [] });
});

NodeTest.test("a removed seam marker is reported with its id", async (t) => {
  const root = await fixture(t, "Layer.mergeAll(\n  // merge-seam: server-layer-old\n");
  NodeAssert.deepEqual(await checkSeams(root), {
    missing: [{ id: "server-layer", file: "apps/server/src/server.ts" }],
  });
});

NodeTest.test("a measured seam needs no marker", async (t) => {
  const root = await fixture(
    t,
    "Layer.mergeAll(\n  MergeServerLayer, // merge-seam: server-layer\n",
  );
  await NodeFSP.writeFile(
    NodePath.join(root, "fork/seams.json"),
    JSON.stringify([
      { id: "server-layer", file: "apps/server/src/server.ts", purpose: "layer" },
      { id: "budget", file: "budget.json", purpose: "measured", check: "measured" },
      { id: "other", file: "budget.json", purpose: "marked" },
    ]),
  );
  NodeAssert.deepEqual(await checkSeams(root), {
    missing: [{ id: "other", file: "budget.json" }],
  });
});

async function baselineFixture(
  t: { after: (fn: () => Promise<void>) => void },
  baseline: string,
  upstreamRef: boolean,
) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "merge-baseline-"));
  t.after(() => NodeFSP.rm(root, { recursive: true, force: true }));
  await NodeFSP.mkdir(NodePath.join(root, "apps/server/src/merge"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(root, "apps/server/src/merge/t3Baseline.ts"),
    `export const T3_CODE_BASELINE_VERSION = "${baseline}";\n`,
  );
  await NodeFSP.writeFile(
    NodePath.join(root, "apps/server/package.json"),
    JSON.stringify({ version: "1.2.3" }),
  );
  const git = (...args: string[]) => NodeChildProcess.execFileSync("git", ["-C", root, ...args]);
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x");
  if (upstreamRef) git("update-ref", "refs/remotes/upstream/main", "HEAD");
  if (upstreamRef) {
    // The fork moves on, then upstream bumps past the merge-base.
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "fork");
  }
  return root;
}

NodeTest.test("a baseline equal to upstream/main is in sync", async (t) => {
  NodeAssert.equal(await checkBaseline(await baselineFixture(t, "1.2.3", true)), null);
});

NodeTest.test("a stale baseline is reported with both versions", async (t) => {
  NodeAssert.deepEqual(await checkBaseline(await baselineFixture(t, "1.2.0", true)), {
    baseline: "1.2.0",
    upstream: "1.2.3",
  });
});

NodeTest.test("an upstream bump after the merge-base is not drift", async (t) => {
  const root = await baselineFixture(t, "1.2.3", true);
  const git = (...args: string[]) => NodeChildProcess.execFileSync("git", ["-C", root, ...args]);
  git("checkout", "-q", "-b", "up", "upstream/main");
  await NodeFSP.writeFile(
    NodePath.join(root, "apps/server/package.json"),
    JSON.stringify({ version: "9.9.9" }),
  );
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "bump");
  git("update-ref", "refs/remotes/upstream/main", "HEAD");
  git("checkout", "-q", "-");
  NodeAssert.equal(await checkBaseline(root), null);
});

NodeTest.test("without an upstream/main ref the baseline check is skipped", async (t) => {
  NodeAssert.equal(await checkBaseline(await baselineFixture(t, "1.2.0", false)), null);
});
