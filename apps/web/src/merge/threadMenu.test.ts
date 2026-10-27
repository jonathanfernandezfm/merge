import { describe, expect, it } from "vite-plus/test";

import type { ThreadActionMenuState } from "../components/threadActionMenu.logic";
import { mergeThreadMenuItems } from "./threadMenu";

describe("mergeThreadMenuItems", () => {
  it("adds no items until fork features register them", () => {
    expect(mergeThreadMenuItems({} as ThreadActionMenuState)).toEqual([]);
  });
});
