import { memo } from "react";

import type { GitGraphRow } from "./gitGraphLayout";

export const GIT_GRAPH_ROW_HEIGHT = 30;
const LANE_WIDTH = 12;
const LANE_INSET = 9;
const MID = GIT_GRAPH_ROW_HEIGHT / 2;

// Theme tokens, so lanes follow light, dark and custom themes. Lane 0 is the branch itself.
const LANE_COLORS = [
  "var(--color-primary)",
  "var(--color-success)",
  "var(--color-warning)",
  "var(--color-info)",
  "var(--color-destructive)",
  "var(--color-muted-foreground)",
];

const laneX = (lane: number) => LANE_INSET + lane * LANE_WIDTH;
const laneColor = (lane: number) => LANE_COLORS[lane % LANE_COLORS.length]!;
export const gitGraphWidth = (laneCount: number) => laneX(Math.max(laneCount, 1) - 1) + LANE_INSET;

/** A curve between two lanes that leaves and arrives vertically; straight when they match. */
function edge(fromLane: number, fromY: number, toLane: number, toY: number) {
  const x1 = laneX(fromLane);
  const x2 = laneX(toLane);
  if (x1 === x2) return `M ${x1} ${fromY} L ${x2} ${toY}`;
  const bend = (toY - fromY) * 0.55;
  return `M ${x1} ${fromY} C ${x1} ${fromY + bend}, ${x2} ${toY - bend}, ${x2} ${toY}`;
}

/** The graph cell of one commit row. */
export const GitGraphCommitLanes = memo(function GitGraphCommitLanes(props: {
  row: GitGraphRow;
  width: number;
  isMerge: boolean;
  selected: boolean;
}) {
  const { row, width, isMerge, selected } = props;
  const color = laneColor(row.lane);
  return (
    <svg
      aria-hidden="true"
      width={width}
      height={GIT_GRAPH_ROW_HEIGHT}
      className="shrink-0 overflow-visible"
      fill="none"
      strokeWidth={1.5}
      strokeLinecap="round"
    >
      {row.passThrough.map((lane) => (
        <path
          key={`p${lane}`}
          d={edge(lane, 0, lane, GIT_GRAPH_ROW_HEIGHT)}
          stroke={laneColor(lane)}
        />
      ))}
      {row.incoming.map((lane) => (
        <path key={`i${lane}`} d={edge(lane, 0, row.lane, MID)} stroke={laneColor(lane)} />
      ))}
      {row.outgoing.map((lane) => (
        <path
          key={`o${lane}`}
          d={edge(row.lane, MID, lane, GIT_GRAPH_ROW_HEIGHT)}
          stroke={laneColor(lane)}
        />
      ))}
      {selected ? (
        <circle cx={laneX(row.lane)} cy={MID} r={7} fill={color} fillOpacity={0.18} />
      ) : null}
      {isMerge ? (
        // Merge commits read as a ring: the point where two lines become one.
        <circle
          cx={laneX(row.lane)}
          cy={MID}
          r={4}
          fill="var(--color-background)"
          stroke={color}
          strokeWidth={2}
        />
      ) : (
        <circle cx={laneX(row.lane)} cy={MID} r={3.5} fill={color} />
      )}
    </svg>
  );
});

/**
 * The merge-base row closing the graph: lines waiting for the base end in a hollow node, and
 * lines to commits outside the branch (side merges from the base) fade out.
 */
export const GitGraphBaseLanes = memo(function GitGraphBaseLanes(props: {
  openLanes: ReadonlyArray<string | null>;
  mergeBase: string | null;
  width: number;
}) {
  const { openLanes, mergeBase, width } = props;
  const baseLane = Math.max(
    0,
    openLanes.findIndex((sha) => sha !== null && sha === mergeBase),
  );
  return (
    <svg
      aria-hidden="true"
      width={width}
      height={GIT_GRAPH_ROW_HEIGHT}
      className="shrink-0 overflow-visible"
      fill="none"
      strokeWidth={1.5}
      strokeLinecap="round"
    >
      {openLanes.map((sha, lane) =>
        sha === null ? null : sha === mergeBase ? (
          <path key={sha} d={edge(lane, 0, baseLane, MID)} stroke={laneColor(lane)} />
        ) : (
          <path
            key={sha}
            d={edge(lane, 0, lane, MID - 2)}
            stroke={laneColor(lane)}
            strokeDasharray="2 3"
            opacity={0.6}
          />
        ),
      )}
      <circle
        cx={laneX(baseLane)}
        cy={MID}
        r={4}
        fill="var(--color-background)"
        stroke="var(--color-muted-foreground)"
        strokeWidth={1.5}
      />
    </svg>
  );
});
