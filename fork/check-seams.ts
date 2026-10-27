import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

interface Seam {
  readonly id: string;
  readonly file: string;
  readonly purpose: string;
}

/** Every `fork/seams.json` entry needs a `merge-seam: <id>` marker in its file. */
export async function checkSeams(root: string) {
  const seams: Seam[] = JSON.parse(
    await NodeFSP.readFile(NodePath.join(root, "fork/seams.json"), "utf8"),
  );
  const missing: Array<{ id: string; file: string }> = [];
  for (const { id, file } of seams) {
    const source = await NodeFSP.readFile(NodePath.join(root, file), "utf8").catch(() => "");
    const ids = new Set(Array.from(source.matchAll(/merge-seam: ([\w-]+)/g), (match) => match[1]));
    if (!ids.has(id)) missing.push({ id, file });
  }
  return { missing };
}

if (import.meta.main) {
  const { missing } = await checkSeams(NodePath.resolve(import.meta.dirname, ".."));
  for (const seam of missing) console.error(`missing seam ${seam.id} in ${seam.file}`);
  process.exitCode = missing.length > 0 ? 1 : 0;
}
