/**
 * Provider compatibility manifests gate on upstream T3 Code versions (`t3CodeRange`), while Merge
 * versions on its own line. Match them against the upstream release this fork tracks.
 * Bump this when syncing upstream; the bundled-manifest test fails if it drifts.
 */
export const T3_CODE_BASELINE_VERSION = "0.1.3";

/** Stands in for `package.json` where compatibility code asks for "the T3 Code version". */
export default { version: T3_CODE_BASELINE_VERSION };
