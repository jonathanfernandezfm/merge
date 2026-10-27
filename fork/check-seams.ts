import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

interface Seam {
  readonly id: string;
  readonly file: string;
  readonly purpose: string;
  /** `measured`: a generated value (JSON) that cannot carry a marker; see SYNC.md. */
  readonly check?: "measured";
}

/** Every `fork/seams.json` entry needs a `merge-seam: <id>` marker in its file, except measured ones. */
export async function checkSeams(root: string) {
  const seams: Seam[] = JSON.parse(
    await NodeFSP.readFile(NodePath.join(root, "fork/seams.json"), "utf8"),
  );
  const missing: Array<{ id: string; file: string }> = [];
  for (const { id, file, check } of seams) {
    if (check === "measured") continue;
    const source = await NodeFSP.readFile(NodePath.join(root, file), "utf8").catch(() => "");
    const ids = new Set(Array.from(source.matchAll(/merge-seam: ([\w-]+)/g), (match) => match[1]));
    if (!ids.has(id)) missing.push({ id, file });
  }
  return { missing };
}

const BASELINE_FILE = "apps/server/src/merge/t3Baseline.ts";

/** Null when `upstream/main` is absent or in sync; otherwise the two versions that disagree. */
export async function checkBaseline(root: string) {
  let upstream: string;
  try {
    const manifest = NodeChildProcess.execFileSync(
      "git",
      ["-C", root, "show", "upstream/main:apps/server/package.json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    upstream = JSON.parse(manifest).version;
  } catch {
    return null;
  }
  const source = await NodeFSP.readFile(NodePath.join(root, BASELINE_FILE), "utf8").catch(() => "");
  const baseline = /T3_CODE_BASELINE_VERSION = "([^"]+)"/.exec(source)?.[1] ?? null;
  return baseline === upstream ? null : { baseline, upstream };
}

if (import.meta.main) {
  const { missing } = await checkSeams(NodePath.resolve(import.meta.dirname, ".."));
  for (const seam of missing) console.error(`missing seam ${seam.id} in ${seam.file}`);
  const drift = await checkBaseline(NodePath.resolve(import.meta.dirname, ".."));
  if (drift) {
    console.error(
      `T3_CODE_BASELINE_VERSION is ${drift.baseline} but upstream/main is ${drift.upstream}; update ${BASELINE_FILE}`,
    );
  }
  process.exitCode = missing.length > 0 || drift ? 1 : 0;
}
