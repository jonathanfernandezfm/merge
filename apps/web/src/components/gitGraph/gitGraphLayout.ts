/** One row of the graph: where the commit's node sits and which lane lines cross the row. */
export interface GitGraphRow {
  readonly lane: number;
  /** Lanes whose line runs from the row's top edge into the node (this commit's children). */
  readonly incoming: ReadonlyArray<number>;
  /** Lanes whose line leaves the node toward the row's bottom edge (this commit's parents). */
  readonly outgoing: ReadonlyArray<number>;
  /** Lanes that cross the row top to bottom without touching the node. */
  readonly passThrough: ReadonlyArray<number>;
}

/**
 * Assigns lanes to commits listed newest first in topological order. Lanes are never compacted,
 * so a line keeps its column (and color) for its whole length.
 * ponytail: freed lanes are reused but never shifted left; fine for branch-sized histories.
 */
export function layoutGitGraph(
  commits: ReadonlyArray<{ readonly sha: string; readonly parents: ReadonlyArray<string> }>,
): {
  rows: GitGraphRow[];
  laneCount: number;
  /** The parent each lane still waits for after the last row, or null for a free lane. */
  openLanes: ReadonlyArray<string | null>;
} {
  const lanes: Array<string | null> = [];
  const rows: GitGraphRow[] = [];
  let laneCount = 0;
  const freeLane = () => {
    const index = lanes.indexOf(null);
    return index < 0 ? lanes.length : index;
  };

  for (const commit of commits) {
    const incoming = lanes.flatMap((sha, index) => (sha === commit.sha ? [index] : []));
    const lane = incoming[0] ?? freeLane();
    for (const index of incoming) lanes[index] = null;
    const passThrough = lanes.flatMap((sha, index) => (sha !== null ? [index] : []));

    const outgoing: number[] = [];
    commit.parents.forEach((parent, parentIndex) => {
      const existing = lanes.indexOf(parent);
      if (existing >= 0) {
        // Another line already waits for this parent; join it instead of opening a lane.
        outgoing.push(existing);
        return;
      }
      const target = parentIndex === 0 && lanes[lane] == null ? lane : freeLane();
      lanes[target] = parent;
      outgoing.push(target);
    });

    rows.push({
      lane,
      incoming,
      outgoing,
      passThrough: passThrough.filter((index) => !outgoing.includes(index)),
    });
    laneCount = Math.max(laneCount, lanes.length, lane + 1);
  }

  return { rows, laneCount, openLanes: lanes };
}
