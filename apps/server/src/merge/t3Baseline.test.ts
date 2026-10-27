import { assert, describe, it } from "@effect/vitest";

import { BUNDLED_MODEL_MANIFEST } from "../provider/ModelManifest.ts";
import { resolveProviderCompatibility } from "../provider/providerCompatibility.ts";

describe("T3 Code baseline", () => {
  it("matches a bundled compatibility policy for every driver", () => {
    const policies = BUNDLED_MODEL_MANIFEST.compatibility ?? [];
    const drivers = new Set(policies.map((policy) => policy.driver));
    assert.isAbove(drivers.size, 0);
    for (const driver of drivers) {
      const advisory = resolveProviderCompatibility(policies, driver as never, null);
      assert.isDefined(advisory, `no policy matches the baseline for ${driver}`);
    }
  });
});
