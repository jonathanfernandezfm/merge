import { describe, expect, it } from "vite-plus/test";

import { taskTitleFromBranch } from "./taskTitleFromBranch";

describe("taskTitleFromBranch", () => {
  it("drops the type prefix and turns separators into spaces", () => {
    expect(taskTitleFromBranch("feature/realms-test")).toBe("realms test");
    expect(taskTitleFromBranch("fix/snake_case__name")).toBe("snake case name");
  });

  it("labels a leading issue number", () => {
    expect(taskTitleFromBranch("feature/#533-mx2-review")).toBe("#533: mx2 review");
    expect(taskTitleFromBranch("#533")).toBe("#533");
  });

  it("keeps only the last path segment", () => {
    expect(taskTitleFromBranch("users/jon/feature-x")).toBe("feature x");
    expect(taskTitleFromBranch("main")).toBe("main");
  });
});
