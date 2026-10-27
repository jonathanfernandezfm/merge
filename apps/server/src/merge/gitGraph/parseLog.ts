import type { GitGraphCommit } from "@t3tools/contracts";

// Unit separators between fields and a record separator per commit survive any commit message.
export const GIT_GRAPH_LOG_FORMAT = "%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%D%x1f%s%x1f%b%x1e";

export function parseGitGraphLog(stdout: string): GitGraphCommit[] {
  const commits: GitGraphCommit[] = [];
  for (const record of stdout.split("\x1e")) {
    const fields = record.replace(/^\n/, "").split("\x1f");
    if (fields.length < 8 || !fields[0]) continue;
    const [sha, parents, authorName, authorEmail, authoredAt, refs, subject, ...body] = fields;
    commits.push({
      sha: sha!,
      parents: parents!.split(" ").filter(Boolean),
      authorName: authorName!,
      authorEmail: authorEmail!,
      authoredAt: authoredAt!,
      refs: refs!
        .split(", ")
        .map((ref) => ref.replace(/^HEAD -> /, "").trim())
        .filter((ref) => ref.length > 0 && ref !== "HEAD"),
      subject: subject!,
      body: body.join("\x1f").trim(),
    });
  }
  return commits;
}

/** Sums `git diff --numstat` lines; binary files report "-" and count as zero lines. */
export function sumNumstat(stdout: string) {
  let fileCount = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of stdout.split("\n")) {
    const [add, del] = line.split("\t");
    if (add === undefined || del === undefined) continue;
    fileCount += 1;
    additions += Number(add) || 0;
    deletions += Number(del) || 0;
  }
  return { fileCount, additions, deletions };
}
