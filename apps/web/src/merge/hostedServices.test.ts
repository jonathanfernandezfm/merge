import { describe, expect, it } from "vite-plus/test";

import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { filterAvailableSettingsSearchItems } from "../components/settings/settingsSearch";

const availability = (hasCloudPublicConfig: boolean) => ({
  hasCloudPublicConfig,
  hasEnvironment: true,
  hasProviderSettingsEnvironment: true,
  hasMacProviderSettingsEnvironment: true,
  canManageLocalBackend: true,
  isWslSettingsRowVisible: true,
  hasThreadAutoSettlement: true,
  managedTunnelActive: true,
});

const hostedIds = ["guest-links", "t3-connect", "hold-webhooks-while-offline"];

describe("hosted T3 services", () => {
  it("are off when the build bakes in no Connect config", () => {
    expect(hasCloudPublicConfig()).toBe(false);
  });

  it("hide Connect, guest sharing and webhook relay settings without that config", () => {
    const ids = filterAvailableSettingsSearchItems(availability(false)).map((item) => item.id);
    for (const id of hostedIds) expect(ids).not.toContain(id);
  });

  it("show them again when a build brings the config", () => {
    const ids = filterAvailableSettingsSearchItems(availability(true)).map((item) => item.id);
    for (const id of hostedIds) expect(ids).toContain(id);
  });
});
