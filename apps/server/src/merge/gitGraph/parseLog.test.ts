import { describe, expect, it } from "vite-plus/test";

import { parseGitGraphLog, sumNumstat } from "./parseLog.ts";

describe("parseGitGraphLog", () => {
  it("keeps bodies with unit separators and newlines, and cleans decorations", () => {
    const record = (sha: string, parents: string, refs: string, subject: string, body: string) =>
      [sha, parents, "Ada", "ada@example.com", "2026-01-02T03:04:05+00:00", refs, subject, body]
        .join("\x1f")
        .concat("\x1e\n");
    const commits = parseGitGraphLog(
      record(
        "b",
        "a",
        "HEAD -> feature/x, tag: v1, origin/feature/x",
        "second",
        "body\n\nwith\x1fodd",
      ) + record("a", "", "HEAD", "root", ""),
    );
    expect(commits.map((commit) => commit.subject)).toEqual(["second", "root"]);
    expect(commits[0]!.refs).toEqual(["feature/x", "tag: v1", "origin/feature/x"]);
    expect(commits[0]!.body).toBe("body\n\nwith\x1fodd");
    expect(commits[0]!.parents).toEqual(["a"]);
    expect(commits[1]!.parents).toEqual([]);
    expect(commits[1]!.refs).toEqual([]);
  });

  it("returns nothing for empty output", () => {
    expect(parseGitGraphLog("")).toEqual([]);
  });
});

describe("sumNumstat", () => {
  it("sums text files and counts binary files without lines", () => {
    expect(sumNumstat("1\t0\ta.txt\n3\t2\tb.txt\n-\t-\timg.png\n")).toEqual({
      fileCount: 3,
      additions: 4,
      deletions: 2,
    });
    expect(sumNumstat("")).toEqual({ fileCount: 0, additions: 0, deletions: 0 });
  });
});
