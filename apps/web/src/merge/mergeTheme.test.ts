import { BUILT_IN_THEMES, type ThemeColors } from "@t3tools/shared/themePalettes";
import { describe, expect, it } from "vite-plus/test";

import indexHtml from "../../index.html?raw";
import { getThemeDefinition, isKnownThemePreference } from "../themePalette";
import { resolveSidebarStageBackdropVariant } from "../components/SidebarStageBackdrop";

const merge = BUILT_IN_THEMES.find((theme) => theme.id === "merge")!;

describe("merge theme", () => {
  it("is a built-in the stored preference `merge` resolves to", () => {
    expect(isKnownThemePreference("merge")).toBe(true);
    expect(getThemeDefinition("merge")?.label).toBe("Merge");
  });

  it("keeps the boot splash palette in sync", () => {
    const boot = (colors: ThemeColors) =>
      [colors.canvas, colors.text, colors.accent, colors.chrome].forEach((value) =>
        expect(indexHtml).toContain(`"${value}"`),
      );
    boot(merge.colors);
    boot(merge.variants!.dark!);
  });

  it("shows the brand texture on release builds and under Dev, not Nightly's sky", () => {
    expect(resolveSidebarStageBackdropVariant("Alpha")).toBe("dev");
    expect(resolveSidebarStageBackdropVariant("Dev")).toBe("dev");
    expect(resolveSidebarStageBackdropVariant("Nightly")).toBe("nightly");
    expect(resolveSidebarStageBackdropVariant("Alpha", false)).toBeNull();
  });
});
