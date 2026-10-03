# Release Checklist

> For maintainers. Using Merge? See [docs/user](../user/).

Merge releases ship desktop installers and `merge-agent` CLI archives to
[GitHub Releases](https://github.com/jonathanfernandezfm/merge/releases). There is no npm
package, hosted web app, relay deployment, or package-manager listing.

## Quick path: ship a stable release

1. Make sure `main` is green in CI.
2. Tag the commit and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. Watch `.github/workflows/release.yml`. Every check and all six desktop builds must pass before
   publishing.
4. Download the artifacts from the GitHub Release and smoke test them.

Pushing any tag that matches `v*.*.*` (except `-nightly.` and `-preview.` suffixes) is a real
stable-channel release. There is no dry-run tag path; do not push a test tag to validate the
workflow.

## Workflows

| Workflow                       | Trigger                                                  | Purpose                                                    |
| ------------------------------ | -------------------------------------------------------- | ---------------------------------------------------------- |
| `release.yml`                  | tag push `v*.*.*`, manual dispatch                       | Desktop + CLI release to GitHub Releases                   |
| `release-desktop.yml`          | called by `release.yml`                                  | One desktop platform/arch build, plus its CLI archive      |
| `ci.yml`                       | pull request, push to `main`                             | Lint, typecheck, tests                                     |
| `windows-tests.yml`            | manual dispatch                                          | Run one package's tests on Windows                         |
| `mobile-eas-preview.yml`       | PR labeled `🚀 Mobile Continuous Deployment`             | EAS preview build/update for that PR                       |
| `mobile-eas-production.yml`    | push to `main` touching mobile code, manual dispatch     | EAS production builds and OTA updates                      |
| `mobile-fingerprint-check.yml` | pull request                                             | Reports whether a PR changes the mobile native fingerprint |
| `pr-size.yml`                  | pull request                                             | PR size labels                                             |
| `issue-labels.yml`             | push to `main` touching issue templates, manual dispatch | Syncs labels used by issue templates                       |

Mobile workflows use the maintainer's own Expo account: set the `EXPO_TOKEN` secret and the
`EXPO_OWNER` and `EAS_PROJECT_ID` repository variables. Without `EXPO_TOKEN`, the EAS steps are
skipped.

## Release channels

`release.yml` resolves one channel per run:

| Channel   | How to start                                           | Result                                                                                        |
| --------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `stable`  | push a `vX.Y.Z` tag, or dispatch with `channel=stable` | GitHub Release; plain `X.Y.Z` is marked latest; finalize commits the version bump to `main`   |
| `nightly` | dispatch with `channel=nightly`                        | GitHub prerelease `vX.Y.Z-nightly.YYYYMMDD.<run>`, published to the `nightly` updater channel |
| `preview` | dispatch with `channel=preview` (the default)          | Maintainer test build; prerelease with no updater metadata, so no installed app is offered it |

- Nightly and stable dispatches must select `main`; preview may select any branch.
- A manual `channel=stable` dispatch builds the commit of the latest published nightly, not `main`
  HEAD, and defaults its version to the one that nightly previewed (`0.0.39-nightly.*` ships as
  `0.0.39`). Pass the `version` input to override it. It fails when no nightly exists, so tag pushes
  are the simplest stable path.
- Nightlies are manual only; there is no scheduled nightly. They use the next stable patch as base
  (`0.0.17` produces `0.0.18-nightly.*`) and never commit to `main`.
- Stable tags with a suffix (for example `1.2.3-alpha.1`) are published as prereleases.
- Generated release notes compare against the previous tag in the same channel. Preview releases get
  a warning body instead.
- Preview installs are reachable only by asking for them: downloading by hand,
  `T3CODE_CHANNEL=preview` for the install scripts, or `merge-agent update --channel preview`.

## What a release run does

- `resolve_commit` and `preflight` pick the commit, channel, version, and tag.
- `quality`, `test`, and `test_server` run lint, typecheck, and tests. Publishing waits for all of
  them.
- `build_bundle` builds the platform-independent JS (server bundle, web client, Electron main) once
  and hands it to every platform job as the `js-bundle` artifact.
- Six desktop jobs (`desktop_<platform>_<arch>`) package it on hardware of their own architecture:
  - macOS `arm64` and `x64` DMG (plus `.zip` update payloads)
  - Linux `x64` and `arm64` AppImage and `.deb`, from one electron-builder run
  - Windows `x64` and `arm64` NSIS installer. These embed the same-arch Linux CLI archive as the WSL
    runtime and wait for that artifact partway through.
- Desktop artifacts are named `Merge-<version>-<arch>.<ext>`.
- Five of those jobs also build, sign, and smoke-test a self-contained CLI archive
  (`merge-agent-<version>-<platform>-<arch>.tar.gz`, `.zip` on Windows) for macOS arm64, Linux x64
  and arm64, and Windows x64 and arm64. There is no macOS x64 archive: Node single-executables are
  unsupported on x64 macOS. The x64 desktop app is Electron and unaffected.
- `release` publishes one GitHub Release with every artifact, the CLI archives, a `SHA256SUMS`
  file, and Electron updater metadata (`latest*.yml` or `nightly*.yml`, `*.blockmap`).
- `finalize` (stable only) commits aligned package versions to `main` with the workflow token. A
  protected `main` must allow GitHub Actions to push.

No hosted relay or Clerk configuration is injected, so Merge Connect stays off in release builds.
Signing is optional and auto-detected per platform from secrets; unsigned builds still publish.

### CLI archive

The archive holds the server as a Node single-executable (`scripts/build-cli-archive.ts`), so
unpacking it needs neither Node, npm, nor a compiler. It is the only form in which Merge manages a
runtime: desktop SSH environments, the background service, `merge-agent update`, and the install
scripts (`scripts/install.sh`, `scripts/install.ps1`) all download it from GitHub Releases and verify
it against `SHA256SUMS`.

- The executable is built with a Node that supports `--build-sea` (`VP_NODE_VERSION`, kept in step
  with `SEA_NODE_VERSION` in `apps/server/vite.config.ts`), while the repo stays on `engines.node`.
- macOS archives are signed with the Developer ID certificate and notarized when the Apple secrets
  are present (ad hoc otherwise). Windows executables use the same Azure Trusted Signing setup as the
  installer. Every native addon in the macOS archive is signed too, since the hardened runtime
  refuses unsigned libraries.
- Each archive is extracted and executed on its build runner (`scripts/smoke-cli-archive.ts`)
  before upload.

## Server self-update invariant

Connected servers update to the client's exact version, not to "latest". Every released desktop
client version must therefore have a matching `merge-agent-<version>` archive on the same GitHub
Release. The release job publishes desktop artifacts and CLI archives together; keep it that way
when changing the release graph, or **Update server** would target an archive that does not exist.

For a release smoke test, connect the new client to a server on the previous version and verify
that the update action reconnects to the matching server. When the release adds database
migrations, verify that the remote update applies them and reconnects.

## Desktop auto-update notes

- Updater runtime: `apps/desktop/src/updates/DesktopUpdates.ts`; `electron-updater` adapter:
  `apps/desktop/src/electron/ElectronUpdater.ts`.
- Background checks run after a startup delay and on an interval. There is no automatic download
  or install: the UI shows an update button; click once to download and again to restart.
- Provider: GitHub Releases (`provider: github`), configured at build time from
  `T3CODE_DESKTOP_UPDATE_REPOSITORY` (`owner/repo`) if set, otherwise `GITHUB_REPOSITORY`.
- The updater needs the platform installers (`.exe`, `.dmg`, `.AppImage`, `.deb`, plus macOS
  `.zip`), the channel metadata, and the `*.blockmap` files.
- `electron-updater` reads `latest-mac.yml` on stable and `nightly-mac.yml` on nightly for both
  Intel and Apple Silicon. The workflow merges the per-arch mac manifests before publishing.
- The `.deb` updates in the app through electron-updater, which installs it with `dpkg`.

### Windows payload topology and update validation

Windows packages the bundled server and only its runtime-external/native dependency closure in
`resources/server.asar`. Native modules and helper executables declared as unpacked by that archive
must be present at the matching paths below `resources/server.asar.unpacked`. Packaged Windows
builds also ship `resources/wsl-runtime.tar.gz` plus its SHA-256 sidecar: the same-arch Linux CLI
archive, copied in verbatim so WSL runs the exact bytes a Linux user downloads. WSL verifies and
extracts it into `~/.merge/wsl-runtime/sha256-<archive-digest>` inside the selected distro.

Windows keeps JavaScript and package metadata inside `app.asar` and unpacks only native libraries
and helper executables. Avoid whole-package smart unpacking: each loose file adds NSIS install work
and counts against the payload limit.

The artifact builder rejects a Windows package when any of these break:

- `resources/server.asar` is absent or does not contain the server entry.
- Any file marked unpacked in the ASAR header is absent from `resources/server.asar.unpacked`.
- On same-architecture builds, the packaged primary cannot load the fff native library from inside
  `server.asar` through its `.unpacked` sibling.
- The isolated, extracted sidecar cannot load the server entry with plain Node.
- A build given `--wsl-runtime` omits the WSL archive or its SHA-256 sidecar, or the digest does
  not match.
- The WSL archive is not a Linux CLI release archive: it must unpack to a single
  `merge-agent-<version>-linux-<arch>` directory with the executable, `client/`, and
  `node_modules/` holding the Linux node-pty binary, and no loose server bundle (`bin.mjs`).
- The external Windows resource monitor is absent.
- The unpacked Windows application contains more than 80 files.

Cross-architecture Windows builds keep every structural and sidecar check but skip executing the
target Electron binary. NSIS differential packaging stays enabled, with a 60 MB maximum for a
representative sidecar-to-sidecar update.

## Apple signing and notarization (macOS)

Optional. Without these secrets, macOS builds are unsigned and users must bypass Gatekeeper.

Secrets:

- `CSC_LINK`: base64 `.p12` of a `Developer ID Application` certificate and key
- `CSC_KEY_PASSWORD`: the `.p12` export password
- `APPLE_API_KEY`: raw `.p8` text of an App Store Connect API key (written to a temporary
  `AuthKey_<id>.p8` at runtime)
- `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`
- `MACOS_PROVISIONING_PROFILE`: base64 provisioning profile for the app ID

Repository variable: `APPLE_TEAM_ID` (10-character Team ID).

Checklist:

1. Create an explicit App ID for `io.github.jonathanfernandezfm.merge`.
2. Create a `Developer ID Application` certificate and a provisioning profile for that App ID.
3. Store the values above, then run a release and confirm the macOS artifacts are signed and
   notarized.

`release-desktop.yml` currently requires `APPLE_TEAM_ID` and `MACOS_PROVISIONING_PROFILE` whenever
the other Apple secrets are set. Passkey (Associated Domains) entitlements are added only when
`T3CODE_CLERK_PUBLISHABLE_KEY` or `T3CODE_CLERK_PASSKEY_RP_DOMAINS` is configured; see
[Merge Connect setup](./connect-setup.md#desktop-passkeys).

## Azure Trusted Signing (Windows)

Optional. Without these secrets, the installer is unsigned and SmartScreen warns on first run.

Secrets: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`,
`AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`,
`AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`, `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`.

1. Create a Trusted Signing account and certificate profile.
2. Create an Entra app registration with Trusted Signing permissions and a client secret.
3. Store the secrets above and confirm the next release's installer is signed.

## Troubleshooting

- macOS build unsigned when expected signed: check every Apple secret plus `APPLE_TEAM_ID` is set
  and non-empty, and that the provisioning profile belongs to
  `<APPLE_TEAM_ID>.io.github.jonathanfernandezfm.merge`.
- Windows build unsigned when expected signed: check every Azure secret is set and non-empty.
- Build fails with a signing error: retry with the secrets removed to confirm the unsigned path
  works, then re-check certificate, profile, and tenant/client values.
- Manual stable dispatch fails in `Resolve release commit`: no nightly exists yet. Push a `vX.Y.Z`
  tag instead.
