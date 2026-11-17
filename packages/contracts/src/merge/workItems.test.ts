import { assert, describe, it } from "vite-plus/test";

import { stripWorkItemPrefixes as strip } from "./workItems.ts";

describe("stripWorkItemPrefixes", () => {
  it("drops ticket numbers and customer codes", () => {
    assert.equal(
      strip("#607374 MXC00463 - AgentUI: Copying ticket link"),
      "AgentUI: Copying ticket link",
    );
    assert.equal(strip("#612559: neo hitl datacard name"), "neo hitl datacard name");
    assert.equal(strip("612559 - Foo"), "Foo");
    assert.equal(strip("Plain title"), "Plain title");
    assert.equal(strip("#123"), "#123");
  });
});
