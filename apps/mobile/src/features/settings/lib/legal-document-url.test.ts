import { afterEach, describe, expect, it, vi } from "vite-plus/test";

async function loadWithMarketingSite(url: string | undefined) {
  vi.resetModules();
  vi.stubEnv("EXPO_PUBLIC_MARKETING_SITE_URL", url);
  return import("./legal-document-url");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isLegalDocumentUrl", () => {
  it.each([
    "https://merge.example/legal",
    "https://merge.example/legal/",
    "https://merge.example/privacy-policy?source=app",
    "https://merge.example/terms-of-service#updates",
    "https://merge.example/security-policy",
  ])("allows a configured legal document: %s", async (url) => {
    const { isLegalDocumentUrl } = await loadWithMarketingSite("https://merge.example");
    expect(isLegalDocumentUrl(url)).toBe(true);
  });

  it.each([
    "https://merge.example/download",
    "https://example.com/legal",
    "javascript:alert(1)",
    "not-a-url",
  ])("rejects a URL outside the legal-document allowlist: %s", async (url) => {
    const { isLegalDocumentUrl } = await loadWithMarketingSite("https://merge.example");
    expect(isLegalDocumentUrl(url)).toBe(false);
  });

  it("has no legal documents when no marketing site is configured", async () => {
    const { LEGAL_URL, isLegalDocumentUrl } = await loadWithMarketingSite(undefined);
    expect(LEGAL_URL).toBeNull();
    expect(isLegalDocumentUrl("https://t3.codes/legal")).toBe(false);
  });
});
