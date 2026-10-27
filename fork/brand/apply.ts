import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as defaultRules from "./rules.ts";

interface Rules {
  readonly identity: ReadonlyArray<{ file: string; from: string; to: string }>;
  readonly copy: { pattern: RegExp; replacement: string; include: string[]; exclude: string[] };
  readonly overlays: ReadonlyArray<string>;
}

const ASSETS_DIR = "fork/brand/assets";
const LOCK_FILE = "fork/brand/overlay.lock.json";

/** Git's blob id, so the lock matches `git rev-parse HEAD:<path>`. */
export const blobSha = (content: Buffer) =>
  NodeCrypto.createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");

async function readOrNull(file: string) {
  try {
    return await NodeFSP.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

const siblingTests = (file: string) => {
  const match = /^(.*)\.(tsx?|mjs)$/.exec(file);
  if (!match || match[1]!.endsWith(".test")) return [];
  return [`${match[1]}.test.ts`, `${match[1]}.test.tsx`, `${match[1]}.test.mjs`];
};

export async function applyBrand(opts: { root: string; check: boolean; rules?: Rules }) {
  const { root, check, rules = defaultRules } = opts;
  const missingAnchors: string[] = [];
  const driftedOverlays: string[] = [];
  const original = new Map<string, string>();
  const next = new Map<string, string>();
  const load = async (file: string) => {
    if (!original.has(file)) {
      const content = await readOrNull(NodePath.join(root, file));
      original.set(file, content?.toString("utf8") ?? "");
      next.set(file, original.get(file)!);
    }
    return next.get(file)!;
  };

  for (const { file, from, to } of rules.identity) {
    // A `to` that contains `from` would grow on every run.
    if (to.includes(from)) throw new Error(`Anchor in ${file} is not idempotent: ${from}`);
    const text = await load(file);
    if (text.includes(from)) next.set(file, text.replaceAll(from, to));
    else if (!text.includes(to)) missingAnchors.push(`${file}: ${from}`);
    // Upstream tests assert the same literals; the sibling may not contain every anchor.
    for (const sibling of siblingTests(file)) {
      if ((await readOrNull(NodePath.join(root, sibling))) === null) continue;
      next.set(sibling, (await load(sibling)).replaceAll(from, to));
    }
  }

  const { pattern, replacement, include, exclude } = rules.copy;
  for await (const entry of NodeFSP.glob(include, { cwd: root, exclude, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = NodePath.relative(root, NodePath.join(entry.parentPath, entry.name));
    const text = await load(file);
    if (text.includes("\0")) continue;
    next.set(file, text.replace(pattern, replacement));
  }

  const changed = [...next.keys()].filter((file) => next.get(file) !== original.get(file));
  if (!check) {
    for (const file of changed) await NodeFSP.writeFile(NodePath.join(root, file), next.get(file)!);
  }

  const lock: Record<string, string | null> = JSON.parse(
    await NodeFSP.readFile(NodePath.join(root, LOCK_FILE), "utf8"),
  );
  for (const file of rules.overlays) {
    const asset = await NodeFSP.readFile(NodePath.join(root, ASSETS_DIR, file));
    const current = await readOrNull(NodePath.join(root, file));
    const currentSha = current && blobSha(current);
    if (currentSha === blobSha(asset)) continue;
    if (currentSha !== (lock[file] ?? null)) {
      driftedOverlays.push(file);
      continue;
    }
    changed.push(file);
    if (check) continue;
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, file), asset);
  }

  return { changed: changed.sort(), missingAnchors, driftedOverlays };
}

/** Records the upstream blob each overlay replaces; run on a tree without the overlay applied. */
async function relock(root: string) {
  const previous = JSON.parse(
    (await readOrNull(NodePath.join(root, LOCK_FILE)))?.toString() ?? "{}",
  );
  const lock: Record<string, string | null> = {};
  for (const file of [...defaultRules.overlays].sort()) {
    const current = await readOrNull(NodePath.join(root, file));
    const asset = await NodeFSP.readFile(NodePath.join(root, ASSETS_DIR, file));
    const sha = current && blobSha(current);
    lock[file] = sha === blobSha(asset) ? (previous[file] ?? null) : sha;
  }
  await NodeFSP.writeFile(NodePath.join(root, LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`);
}

if (import.meta.main) {
  const root = NodePath.resolve(import.meta.dirname, "../..");
  const args = process.argv.slice(2);
  if (args.includes("--relock")) {
    await relock(root);
  } else {
    const check = args.includes("--check");
    const result = await applyBrand({ root, check });
    for (const file of result.changed) console.log(`${check ? "pending" : "changed"} ${file}`);
    for (const anchor of result.missingAnchors) console.error(`missing anchor ${anchor}`);
    for (const file of result.driftedOverlays) console.error(`drifted overlay ${file}`);
    const broken = result.missingAnchors.length + result.driftedOverlays.length > 0;
    process.exitCode = broken || (check && result.changed.length > 0) ? 1 : 0;
  }
}
