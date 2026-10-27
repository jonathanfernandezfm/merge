import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { checkSeams } from "./check-seams.ts";

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

NodeTest.test("a removed seam marker is reported with its id", async (t) => {
  const root = await fixture(t, "Layer.mergeAll(\n  // merge-seam: server-layer-old\n");
  NodeAssert.deepEqual(await checkSeams(root), {
    missing: [{ id: "server-layer", file: "apps/server/src/server.ts" }],
  });
});
