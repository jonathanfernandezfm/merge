/**
 * The Merge brand overlay. `identity` anchors are exact upstream strings, so a sync that
 * moves or rewrites one fails `--check` instead of silently shipping T3 Code identity.
 */

const REPO = "jonathanfernandezfm/merge";
const REPO_URL = `https://github.com/${REPO}`;
const APP_ID = "io.github.jonathanfernandezfm.merge";
const AUTHOR = "Jonathan Fernandez Mertanen";

const BUILD = "scripts/build-desktop-artifact.ts";
const MOBILE_CONFIG = "apps/mobile/app.config.ts";
const DESKTOP_ENV = "apps/desktop/src/app/DesktopEnvironment.ts";
const EARLY_STARTUP = "apps/desktop/src/app/DesktopEarlyElectronStartup.ts";
const USER_DATA = "apps/desktop/src/app/DesktopUserData.ts";
const PROTOCOL = "apps/desktop/src/electron/ElectronProtocol.ts";
const AUTH_HANDOFF = "packages/shared/src/codexAuthHandoff.ts";
const PROMPT_LINKS = "packages/shared/src/promptLinks.ts";
const LAUNCHER = "apps/desktop/scripts/electron-launcher.mjs";

export const identity: Array<{ file: string; from: string; to: string }> = [
  // Nightly and preview release names.
  {
    file: "scripts/resolve-nightly-release.ts",
    from: "name: `T3 Code ${CHANNEL_RELEASE_LABELS[channel]}",
    to: "name: `Merge ${CHANNEL_RELEASE_LABELS[channel]}",
  },
  // Installer and app identity.
  {
    file: "apps/desktop/package.json",
    from: '"productName": "T3 Code (Beta)"',
    to: '"productName": "Merge (Alpha)"',
  },
  {
    file: DESKTOP_ENV,
    from: 'const APP_BASE_NAME = "T3 Code";',
    to: 'const APP_BASE_NAME = "Merge";',
  },
  {
    file: DESKTOP_ENV,
    from: 'isDevelopment ? "com.t3tools.t3code.dev" : "com.t3tools.t3code",',
    to: `isDevelopment\n        ? "${APP_ID}.dev"\n        : "${APP_ID}",`,
  },
  {
    file: DESKTOP_ENV,
    from: 'linuxWmClass: isDevelopment ? "t3code-dev" : "t3code",',
    to: 'linuxWmClass: isDevelopment ? "merge-dev" : "merge",',
  },
  {
    file: EARLY_STARTUP,
    from: 'isDevelopment ? "com.t3tools.T3Code.Development.desktop" : "com.t3tools.T3Code.desktop";',
    to: 'isDevelopment\n    ? "io.github.jonathanfernandezfm.Merge.Development.desktop"\n    : "io.github.jonathanfernandezfm.Merge.desktop";',
  },
  {
    file: EARLY_STARTUP,
    from: 'linuxWmClass: isDevelopment ? "t3code-dev" : "t3code",',
    to: 'linuxWmClass: isDevelopment ? "merge-dev" : "merge",',
  },
  {
    file: BUILD,
    from: 'const DESKTOP_APP_ID = "com.t3tools.t3code";',
    to: `const DESKTOP_APP_ID = "${APP_ID}";`,
  },
  { file: BUILD, from: 'executableName: "t3code",', to: 'executableName: "merge",' },
  { file: BUILD, from: 'StartupWMClass: "t3code",', to: 'StartupWMClass: "merge",' },
  { file: BUILD, from: 'name: "t3code",', to: 'name: "merge",' },
  {
    file: BUILD,
    from: 'maintainer: "T3 Tools <hello@t3.codes>",',
    to: `maintainer: "${AUTHOR} <jonathanfernandezfm@gmail.com>",`,
  },
  { file: BUILD, from: 'homepage: "https://t3.codes",', to: `homepage: "${REPO_URL}",` },
  { file: BUILD, from: 'author: "T3 Tools",', to: `author: "${AUTHOR}",` },
  {
    file: BUILD,
    from: '"apps/desktop/resources/linux/com.t3tools.t3code.metainfo.xml")}=/usr/share/metainfo/com.t3tools.t3code.metainfo.xml`',
    to: `"apps/desktop/resources/linux/${APP_ID}.metainfo.xml")}=/usr/share/metainfo/${APP_ID}.metainfo.xml\``,
  },
  {
    file: BUILD,
    from: "=/usr/share/doc/t3code/copyright`",
    to: "=/usr/share/doc/merge/copyright`",
  },
  { file: MOBILE_CONFIG, from: "com.t3tools.t3code", to: APP_ID },
  { file: MOBILE_CONFIG, from: 'slug: "t3-code",', to: 'slug: "merge",' },
  // EAS project and owner come from the environment, as in v0.0.10.
  {
    file: MOBILE_CONFIG,
    from: 'url: "https://u.expo.dev/d763fcb8-d37c-41ea-a773-b54a0ab4a454",',
    to: "...(process.env.EAS_PROJECT_ID\n      ? { url: `https://u.expo.dev/${process.env.EAS_PROJECT_ID}` }\n      : {}),",
  },
  {
    file: MOBILE_CONFIG,
    from: 'eas: {\n      projectId: "d763fcb8-d37c-41ea-a773-b54a0ab4a454",\n    },',
    to: "...(process.env.EAS_PROJECT_ID ? { eas: { projectId: process.env.EAS_PROJECT_ID } } : {}),",
  },
  {
    file: MOBILE_CONFIG,
    from: 'owner: "pingdotgg",',
    to: "...(process.env.EXPO_OWNER ? { owner: process.env.EXPO_OWNER } : {}),",
  },
  {
    file: LAUNCHER,
    from: 'const APP_DISPLAY_NAME = isDevelopment ? "T3 Code (Dev)" : "T3 Code (Beta)";',
    to: 'const APP_DISPLAY_NAME = isDevelopment ? "Merge (Dev)" : "Merge (Alpha)";',
  },
  {
    file: LAUNCHER,
    from: '? `com.t3tools.t3code.dev.${devBundleIdSuffix || "local"}`\n  : "com.t3tools.t3code";',
    to: `? \`${APP_ID}.dev.\${devBundleIdSuffix || "local"}\`\n  : "${APP_ID}";`,
  },

  // Data paths. Mirror upstream's V1/V2 split on our own names: V2 runs in `merge-v2` and only
  // imports from v0.0.10's `merge` profile, never from T3 Code's.
  {
    file: "apps/desktop/src/app/DesktopStatePaths.ts",
    from: 'input.joinPath(input.homeDirectory, ".t3"),',
    to: 'input.joinPath(input.homeDirectory, ".merge"),',
  },
  {
    file: "apps/server/src/os-jank.ts",
    from: 'join(yield* HostProcess.HomeDirectory, ".t3")',
    to: 'join(yield* HostProcess.HomeDirectory, ".merge")',
  },
  {
    file: "apps/server/src/cli/browser.ts",
    from: 'path.join(home, ".t3")',
    to: 'path.join(home, ".merge")',
  },
  {
    file: USER_DATA,
    from: '{ current: "t3code-dev", legacy: "T3 Code (Dev)" }',
    to: '{ current: "merge-dev", legacy: "merge-dev" }',
  },
  {
    file: USER_DATA,
    from: '{ current: "t3code-v2", legacy: "T3 Code (Alpha)" }',
    to: '{ current: "merge-v2", legacy: "merge" }',
  },
  {
    file: USER_DATA,
    from: 'path.join(input.appDataDirectory, "t3code", "Local State")',
    to: 'path.join(input.appDataDirectory, "merge", "Local State")',
  },
  {
    file: "apps/desktop/src/app/DesktopLegacyLocalStorage.ts",
    from: 'const V1_PROFILE_NAMES = ["T3 Code (Alpha)", "t3code"];',
    to: 'const V1_PROFILE_NAMES = ["merge"];',
  },

  // URL schemes.
  {
    file: PROTOCOL,
    from: 'DESKTOP_PRODUCTION_SCHEME = "t3code";',
    to: 'DESKTOP_PRODUCTION_SCHEME = "merge";',
  },
  {
    file: PROTOCOL,
    from: 'DESKTOP_DEVELOPMENT_SCHEME = "t3code-dev";',
    to: 'DESKTOP_DEVELOPMENT_SCHEME = "merge-dev";',
  },
  {
    file: LAUNCHER,
    from: 'APP_PROTOCOL_SCHEMES = isDevelopment ? ["t3code-dev"] : ["t3code"];',
    to: 'APP_PROTOCOL_SCHEMES = isDevelopment ? ["merge-dev"] : ["merge"];',
  },
  {
    file: BUILD,
    from: 'schemes: ["t3code", "t3code-dev"],',
    to: 'schemes: ["merge", "merge-dev"],',
  },
  {
    file: "apps/server/src/httpCors.ts",
    from: '["t3code://app", "t3code-dev://app"]',
    to: '["merge://app", "merge-dev://app"]',
  },
  {
    file: AUTH_HANDOFF,
    from: '`${development ? "t3code-dev" : "t3code"}://auth/codex`',
    to: '`${development ? "merge-dev" : "merge"}://auth/codex`',
  },
  {
    file: AUTH_HANDOFF,
    from: '(development ? "t3code-dev:" : "t3code:")',
    to: '(development ? "merge-dev:" : "merge:")',
  },
  {
    file: "packages/shared/src/providerAuthReturnUrl.ts",
    from: '["t3code:", "t3code-dev:"]',
    to: '["merge:", "merge-dev:"]',
  },
  {
    file: PROMPT_LINKS,
    from: "const APP_SCHEME = /^t3code(?:-[a-z]+)?:$/;",
    to: "const APP_SCHEME = /^merge(?:-[a-z]+)?:$/;",
  },
  { file: PROMPT_LINKS, from: 'scheme = "t3code"): string {', to: 'scheme = "merge"): string {' },
  { file: MOBILE_CONFIG, from: 'scheme: "t3code', to: 'scheme: "merge' },
  {
    file: "apps/mobile/src/App.tsx",
    from: '"t3code://", "t3code-dev://", "t3code-preview://"',
    to: '"merge://", "merge-dev://", "merge-preview://"',
  },
  {
    file: "apps/mobile/src/features/connection/pairing.ts",
    from: 'url.protocol === "t3code:"',
    to: 'url.protocol === "merge:"',
  },
  {
    file: "apps/mobile/src/features/agent-awareness/androidNotifications.ts",
    from: '?? "t3code";',
    to: '?? "merge";',
  },
  { file: "apps/mobile/src/widgets/AgentActivity.tsx", from: "`t3code://${", to: "`merge://${" },

  // Update feed, telemetry default and repo links.
  {
    file: "apps/web/src/components/desktopUpdate.logic.ts",
    from: 'DEFAULT_DESKTOP_RELEASE_REPOSITORY = "pingdotgg/t3code";',
    to: `DEFAULT_DESKTOP_RELEASE_REPOSITORY = "${REPO}";`,
  },
  {
    file: "packages/shared/src/cliRelease.ts",
    from: 'CLI_RELEASE_REPOSITORY = "pingdotgg/t3code";',
    to: `CLI_RELEASE_REPOSITORY = "${REPO}";`,
  },
  {
    file: "apps/server/src/telemetry/AnalyticsService.ts",
    from: 'Config.Boolean("T3CODE_TELEMETRY_ENABLED").pipe(Config.withDefault(true))',
    to: 'Config.Boolean("T3CODE_TELEMETRY_ENABLED").pipe(Config.withDefault(false))',
  },
  {
    file: "apps/server/src/provider/ModelManifest.ts",
    from: "https://raw.githubusercontent.com/pingdotgg/t3code/main/",
    to: `https://raw.githubusercontent.com/${REPO}/main/`,
  },
  { file: "apps/server/src/cli/triagePrompt.ts", from: "pingdotgg/t3code", to: REPO },
  // triagePrompt.test.ts keeps the prompt byte-identical to this file, which the prompt fetches.
  { file: ".github/triage/PLAYBOOK.md", from: "pingdotgg/t3code", to: REPO },
  {
    file: "apps/server/src/project/ManagedProjectFolders.ts",
    from: '"Created in [T3 Code](https://t3.codes).",',
    to: `"Created in [Merge](${REPO_URL}).",`,
  },
  // Default theme: a client with no stored preference wears `merge` (the id existing installs
  // already store) and follows the OS appearance, as the unthemed look did.
  {
    file: "apps/web/src/hooks/useTheme.ts",
    from: 'theme: "system",\n  resolvedTheme: "light",',
    to: 'theme: "merge",\n  resolvedTheme: "light",',
  },
  {
    file: "apps/web/src/hooks/useTheme.ts",
    from: 'return theme === "system";',
    to: 'return theme === "system" || theme === "merge";',
  },
  {
    file: "apps/web/index.html",
    from: 'storedTheme === null ? "" :',
    to: 'storedTheme === null ? "merge" :',
  },
  {
    file: "apps/web/index.html",
    from: "(isKnownTheme && storedTheme !== null)",
    to: "isKnownTheme",
  },
  {
    file: "apps/desktop/src/window/DesktopWindow.ts",
    from: 'return shouldUseDarkColors ? "#000000" : "#ffffff";',
    to: 'return shouldUseDarkColors ? "#0a0c0f" : "#f5f4ef";',
  },

  // Mobile's fallback for a missing or unknown stored theme matches v0.0.10: Merge.
  {
    file: "apps/mobile/src/lib/mobileTheme.ts",
    from: "    : DEFAULT_MOBILE_THEME_ID;",
    to: '    : "merge";',
  },
  {
    file: "apps/mobile/src/lib/mobileTheme.test.ts",
    from: '      light: DEFAULT_MOBILE_THEME_ID,\n      dark: "grove",',
    to: '      light: "merge",\n      dark: "grove",',
  },
  // The environment identification row is always visible, so its copy covers every build.
  {
    file: "apps/web/src/components/settings/AppearanceSettingsPanel.tsx",
    from: "Choose how Dev and Nightly environments are identified.",
    to: "Choose how the sidebar header identifies this build.",
  },

  // Hosted T3 services (Connect, relay, guest sharing, webhook relay) switch on only when a build
  // bakes in the Clerk key and relay URL, so shipping no defaults keeps every entry point hidden.
  {
    file: ".env.example",
    from: "T3CODE_CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsudDMuY29kZXMk",
    to: "T3CODE_CLERK_PUBLISHABLE_KEY=",
  },
  {
    file: ".env.example",
    from: "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=hzxSgY2cH10sDU2r",
    to: "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=",
  },
  {
    file: ".env.example",
    from: "T3CODE_RELAY_URL=https://relay.t3.codes",
    to: "T3CODE_RELAY_URL=",
  },
  // Upstream tests whose literals differ from the source anchors (siblings get those for free).
  {
    file: "apps/desktop/src/app/DesktopAppIdentity.test.ts",
    from: "/T3 Code \\((Alpha|Dev)\\)/.test(path)",
    to: "/\\/merge(-dev)?$/.test(path)",
  },
  {
    file: "apps/desktop/src/app/DesktopAppIdentity.test.ts",
    from: "Application Support/t3code-v2",
    to: "Application Support/merge-v2",
  },
  {
    file: "apps/desktop/src/app/DesktopAppIdentity.test.ts",
    from: "Application Support/T3 Code (Dev)",
    to: "Application Support/merge-dev",
  },
  {
    file: "apps/desktop/src/app/DesktopEnvironment.test.ts",
    from: '"/Users/alice/.t3/',
    to: '"/Users/alice/.merge/',
  },
  {
    file: "apps/desktop/src/app/DesktopUserData.test.ts",
    from: 'it.effect.each(["t3code", "T3 Code (Alpha)"])(',
    to: 'it.effect.each(["merge"])(',
  },
  {
    file: "apps/desktop/src/app/DesktopUserData.test.ts",
    from: 'path.join(directory, "t3code-v2")',
    to: 'path.join(directory, "merge-v2")',
  },
  {
    file: "apps/desktop/src/app/DesktopUserData.test.ts",
    from: 'path.join(directory, "T3 Code (Alpha)")',
    to: 'path.join(directory, "merge")',
  },
  {
    file: "packages/shared/src/promptLinks.test.ts",
    from: 'promptLinkAppPath("t3code',
    to: 'promptLinkAppPath("merge',
  },
  {
    file: "packages/shared/src/providerAuthReturnUrl.test.ts",
    from: 'it.each(["t3code", "t3code-dev"])(',
    to: 'it.each(["merge", "merge-dev"])(',
  },
  {
    file: "apps/web/src/components/desktopUpdate.logic.test.ts",
    from: "https://github.com/pingdotgg/t3code/releases",
    to: `${REPO_URL}/releases`,
  },
  {
    file: "apps/mobile/src/features/connection/pairing.test.ts",
    from: '"t3code://pair?',
    to: '"merge://pair?',
  },
];

export const copy = {
  // `\b` alone misses "T3 Code" right after an escaped newline in source strings ("\n\nT3 Code").
  pattern: /(?<=^|\W|\\n)T3 Code\b/g,
  replacement: "Merge",
  include: [
    "apps/web/src/**",
    "apps/desktop/src/**",
    "apps/mobile/src/**",
    "apps/server/src/**",
    "apps/marketing/src/**",
    "packages/*/src/**",
    "apps/web/index.html",
    "apps/web/public/manifest.webmanifest",
    ".github/triage/PLAYBOOK.md",
    MOBILE_CONFIG,
    BUILD,
  ],
  exclude: [
    // Verbatim quotes from T3 Code users.
    "apps/marketing/src/lib/tweets.ts",
  ],
};

/** Whole files replaced from `fork/brand/assets/<path>`; `overlay.lock.json` holds the upstream blob each replaces. */
export const overlays: string[] = [
  "apps/marketing/public/apple-touch-icon.png",
  "apps/marketing/public/favicon-16x16.png",
  "apps/marketing/public/favicon-32x32.png",
  "apps/marketing/public/favicon.ico",
  "apps/marketing/src/assets/icon-nightly.webp",
  "apps/marketing/src/assets/icon.webp",
  "apps/mobile/assets/android-icon-background-dev.png",
  "apps/mobile/assets/android-icon-background-nightly.png",
  "apps/mobile/assets/android-icon-foreground.png",
  "apps/mobile/assets/android-icon-mark.png",
  "apps/mobile/assets/android-notification-icon.png",
  "apps/mobile/assets/android-splash-icon-dev.png",
  "apps/mobile/assets/android-splash-icon-nightly.png",
  "apps/mobile/assets/android-splash-icon-prod.png",
  "apps/mobile/assets/merge-logo.webp",
  "apps/mobile/assets/widget/T3Mark.svg",
  "apps/mobile/src/components/T3Wordmark.tsx",
  "apps/web/public/apple-touch-icon.png",
  "apps/web/public/favicon-16x16.png",
  "apps/web/public/favicon-32x32.png",
  "apps/web/public/favicon.ico",
  "apps/web/src/assets/merge-logo.webp",
  "apps/web/src/components/T3Wordmark.tsx",
  "assets/dev/blueprint-ios-1024.png",
  "assets/dev/blueprint-macos-1024.png",
  "assets/dev/blueprint-universal-1024.png",
  "assets/dev/blueprint-web-apple-touch-180.png",
  "assets/dev/blueprint-web-favicon-16x16.png",
  "assets/dev/blueprint-web-favicon-32x32.png",
  "assets/dev/blueprint-web-favicon.ico",
  "assets/dev/blueprint-windows.ico",
  "assets/nightly/nightly-ios-1024.png",
  "assets/nightly/nightly-macos-1024.png",
  "assets/nightly/nightly-universal-1024.png",
  "assets/nightly/nightly-web-apple-touch-180.png",
  "assets/nightly/nightly-web-favicon-16x16.png",
  "assets/nightly/nightly-web-favicon-32x32.png",
  "assets/nightly/nightly-web-favicon.ico",
  "assets/nightly/nightly-windows.ico",
  "assets/prod/black-ios-1024.png",
  "assets/prod/black-macos-1024.png",
  "assets/prod/black-universal-1024.png",
  "assets/prod/logo.svg",
  "assets/prod/merge-logo.png",
  "assets/prod/t3-black-web-apple-touch-180.png",
  "assets/prod/t3-black-web-favicon-16x16.png",
  "assets/prod/t3-black-web-favicon-32x32.png",
  "assets/prod/t3-black-web-favicon.ico",
  "assets/prod/t3-black-windows.ico",
  "apps/desktop/resources/linux/io.github.jonathanfernandezfm.merge.metainfo.xml",
];
