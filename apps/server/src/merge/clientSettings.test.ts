// @effect-diagnostics nodeBuiltinImport:off
import { ClientSettingsSchema } from "@t3tools/contracts";
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

const decode = Schema.decodeUnknownSync(ClientSettingsSchema);
// A copy of a real v0.0.10 install's client-settings.json, when this machine has one.
const LIVE_COPY = "/tmp/merge-resync/client-settings.json";

describe("v0.0.10 client settings", () => {
  it("keep decoding; the theme lives in browser storage, not here", () => {
    const settings = decode({ environmentIdentificationMode: "artwork" });
    expect(settings.environmentIdentificationMode).toBe("artwork");
    expect("theme" in settings).toBe(false);
  });

  it.skipIf(!NodeFS.existsSync(LIVE_COPY))("decode a real install's file", () => {
    const settings = decode(JSON.parse(NodeFS.readFileSync(LIVE_COPY, "utf8")));
    expect(settings.environmentIdentificationMode).toBe("artwork");
    expect(settings.favorites.length).toBeGreaterThan(0);
  });
});
