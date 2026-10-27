import type { CSSProperties } from "react";

// The logo's lime on its near-black tile. Theme-independent on purpose: it is the brand mark and
// stays dark under the white sidebar wordmark.
const TOP = "oklch(0.215 0.03 124)";
const MID = "oklch(0.17 0.012 124)";
const BOTTOM = "oklch(0.145 0.003 286)";
const ACCENT = "oklch(0.888 0.205 122.5)";

const MERGE_TEXTURE_STYLE: CSSProperties = {
  background: [
    `radial-gradient(circle at center, color-mix(in oklch, ${ACCENT} 7%, transparent) 0.5px, transparent 0.75px) 0 0 / 6px 6px`,
    `radial-gradient(ellipse 120% 160% at 85% 0%, color-mix(in oklch, ${ACCENT} 14%, transparent), transparent 70%)`,
    `linear-gradient(100deg, ${BOTTOM}, ${MID} 45%, ${TOP})`,
  ].join(", "),
};

/** Brand texture as one CSS layer, so the gradient spans the full surface at any width. */
export function MergeTextureArt() {
  return <div data-stage-art="merge" className="size-full" style={MERGE_TEXTURE_STYLE} />;
}
