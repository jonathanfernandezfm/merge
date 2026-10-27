import { describe, expect, it } from "vite-plus/test";

import { layoutGitGraph } from "./gitGraphLayout";

describe("layoutGitGraph", () => {
  it("keeps a linear branch in one lane", () => {
    const { rows, laneCount } = layoutGitGraph([
      { sha: "c", parents: ["b"] },
      { sha: "b", parents: ["a"] },
      { sha: "a", parents: [] },
    ]);
    expect(laneCount).toBe(1);
    expect(rows.map((row) => [row.lane, row.incoming, row.outgoing])).toEqual([
      [0, [], [0]],
      [0, [0], [0]],
      [0, [0], []],
    ]);
  });

  it("opens a lane for a merged side branch and closes it at the fork", () => {
    //  m
    //  |\
    //  x y
    //  |/
    //  a
    const { rows, laneCount } = layoutGitGraph([
      { sha: "m", parents: ["x", "y"] },
      { sha: "x", parents: ["a"] },
      { sha: "y", parents: ["a"] },
      { sha: "a", parents: [] },
    ]);
    expect(laneCount).toBe(2);
    expect(rows[0]).toEqual({ lane: 0, incoming: [], outgoing: [0, 1], passThrough: [] });
    expect(rows[1]).toEqual({ lane: 0, incoming: [0], outgoing: [0], passThrough: [1] });
    // y joins the line already waiting for a in lane 0.
    expect(rows[2]).toEqual({ lane: 1, incoming: [1], outgoing: [0], passThrough: [] });
    expect(rows[3]).toEqual({ lane: 0, incoming: [0], outgoing: [], passThrough: [] });
  });

  it("lets lines to commits outside the list run past the last row", () => {
    const { rows, openLanes } = layoutGitGraph([
      { sha: "m", parents: ["x", "outside"] },
      { sha: "x", parents: ["base"] },
    ]);
    expect(rows[1]).toEqual({ lane: 0, incoming: [0], outgoing: [0], passThrough: [1] });
    expect(openLanes).toEqual(["base", "outside"]);
  });
});
