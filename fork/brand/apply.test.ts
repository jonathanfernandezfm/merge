import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { applyBrand, blobSha } from "./apply.ts";

const ENV_FILE = "apps/desktop/src/app/DesktopEnvironment.ts";
const ICON = "assets/prod/icon.png";

const rules = {
  identity: [
    {
      file: ENV_FILE,
      from: 'const APP_BASE_NAME = "T3 Code";',
      to: 'const APP_BASE_NAME = "Merge";',
    },
    { file: ENV_FILE, from: '"com.t3tools.t3code"', to: '"io.github.jonathanfernandezfm.merge"' },
  ],
  copy: {
    pattern: /\bT3 Code\b/g,
    replacement: "Merge",
    include: ["apps/web/src/**"],
    exclude: ["apps/web/src/excluded.ts", "**/src/merge/**"],
  },
  overlays: [ICON],
};

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "merge-brand-"));
  t.after(() => NodeFSP.rm(root, { recursive: true, force: true }));
  const put = async (file: string, content: string | Buffer) => {
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, file), content);
  };
  const upstreamIcon = Buffer.from("upstream-icon");
  await put(ENV_FILE, 'const APP_BASE_NAME = "T3 Code";\nconst ID = "com.t3tools.t3code";\n');
  await put("apps/web/src/included.ts", 'export const label = "Open T3 Code";\n');
  await put("apps/web/src/excluded.ts", 'export const label = "Open T3 Code";\n');
  await put("apps/web/src/merge/fork.ts", 'export const label = "Open T3 Code";\n');
  await put(ICON, upstreamIcon);
  await put(`fork/brand/assets/${ICON}`, "merge-icon");
  await put("fork/brand/overlay.lock.json", JSON.stringify({ [ICON]: blobSha(upstreamIcon) }));
  const read = (file: string) => NodeFSP.readFile(NodePath.join(root, file), "utf8");
  return { root, put, read };
}

NodeTest.test("applies identity anchors, copy and overlays, then is idempotent", async (t) => {
  const { root, read } = await fixture(t);

  const first = await applyBrand({ root, check: false, rules });
  NodeAssert.deepEqual(first.missingAnchors, []);
  NodeAssert.deepEqual(first.driftedOverlays, []);
  NodeAssert.deepEqual(first.changed, [ENV_FILE, "apps/web/src/included.ts", ICON]);
  NodeAssert.match(await read(ENV_FILE), /const APP_BASE_NAME = "Merge";/);
  NodeAssert.equal(await read("apps/web/src/included.ts"), 'export const label = "Open Merge";\n');
  NodeAssert.equal(
    await read("apps/web/src/excluded.ts"),
    'export const label = "Open T3 Code";\n',
  );
  NodeAssert.equal(
    await read("apps/web/src/merge/fork.ts"),
    'export const label = "Open T3 Code";\n',
  );
  NodeAssert.equal(await read(ICON), "merge-icon");

  const second = await applyBrand({ root, check: true, rules });
  NodeAssert.deepEqual(second, { changed: [], missingAnchors: [], driftedOverlays: [] });
});

NodeTest.test("check mode reports pending changes without writing", async (t) => {
  const { root, read } = await fixture(t);
  const result = await applyBrand({ root, check: true, rules });
  NodeAssert.equal(result.changed.length, 3);
  NodeAssert.match(await read(ENV_FILE), /"T3 Code"/);
});

NodeTest.test("reports an anchor whose from and to are both gone", async (t) => {
  const { root, put } = await fixture(t);
  await put(ENV_FILE, 'const APP_BASE_NAME = "T3 Code";\nconst ID = "com.t3tools.renamed";\n');
  const result = await applyBrand({ root, check: true, rules });
  NodeAssert.deepEqual(result.missingAnchors, [`${ENV_FILE}: "com.t3tools.t3code"`]);
});

NodeTest.test("reports an overlay whose upstream blob no longer matches the lock", async (t) => {
  const { root, put, read } = await fixture(t);
  await put(ICON, "upstream-icon-v2");
  const result = await applyBrand({ root, check: false, rules });
  NodeAssert.deepEqual(result.driftedOverlays, [ICON]);
  NodeAssert.equal(await read(ICON), "upstream-icon-v2");
});

NodeTest.test(
  "identity anchors also apply to a sibling test file, without requiring them",
  async (t) => {
    const { root, put, read } = await fixture(t);
    const sibling = "apps/desktop/src/app/DesktopEnvironment.test.ts";
    await put(sibling, 'assert.equal(id, "com.t3tools.t3code");\n');

    const first = await applyBrand({ root, check: false, rules });
    NodeAssert.deepEqual(first.missingAnchors, []);
    NodeAssert.ok(first.changed.includes(sibling));
    NodeAssert.equal(
      await read(sibling),
      'assert.equal(id, "io.github.jonathanfernandezfm.merge");\n',
    );

    const second = await applyBrand({ root, check: true, rules });
    NodeAssert.deepEqual(second, { changed: [], missingAnchors: [], driftedOverlays: [] });
  },
);
