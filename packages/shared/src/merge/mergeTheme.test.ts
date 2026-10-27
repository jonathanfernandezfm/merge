import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_THEME_IDS, BUILT_IN_THEMES, RESERVED_THEME_IDS } from "../themePalettes.ts";
import { THEME_COLOR_ROLES } from "../themePalettes.ts";
import { MERGE_THEME } from "./mergeTheme.ts";

describe("MERGE_THEME", () => {
  it("keeps the id v0.0.10 installs store, and registers as a built-in", () => {
    expect(MERGE_THEME.id).toBe("merge");
    expect(BUILT_IN_THEME_IDS).toContain("merge");
    expect(BUILT_IN_THEMES).toContain(MERGE_THEME);
    expect(RESERVED_THEME_IDS.has("merge")).toBe(true);
  });

  it("defines every role in both appearances", () => {
    for (const colors of [MERGE_THEME.colors, MERGE_THEME.variants!.dark!]) {
      for (const role of THEME_COLOR_ROLES) expect(colors[role], role).toMatch(/^oklch\(/);
    }
  });
});
