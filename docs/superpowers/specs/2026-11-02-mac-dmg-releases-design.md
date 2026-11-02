# Mac DMG GitHub Releases — Design

Date: 2026-11-02  
Status: Approved

## Goal

Publish unsigned Focus installers for Apple Silicon and Intel Macs as a GitHub Release, and link them from the README so users can download without building from source.

## Decisions

| Topic | Choice |
| --- | --- |
| Delivery | GitHub Release assets (not committed into git) |
| Packaging | Two separate DMGs |
| Signing | Unsigned |
| Automation | Manual build and publish for this pass |
| Version | `v0.1.0` (matches `package.json` / `tauri.conf.json`) |

## Release assets

Tag: `v0.1.0` on `w2vasia/focus-app`

| File | Architecture |
| --- | --- |
| `Focus_0.1.0_aarch64.dmg` | Apple Silicon (`aarch64-apple-darwin`) |
| `Focus_0.1.0_x64.dmg` | Intel (`x86_64-apple-darwin`) |

Built locally with Tauri:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run tauri build -- --target aarch64-apple-darwin
npm run tauri build -- --target x86_64-apple-darwin
```

DMGs are taken from `src-tauri/target/<triple>/release/bundle/dmg/` (or the equivalent Tauri output path for that target) and attached with `gh release create`.

## README

Add a **Download** section after the screenshot:

- Direct links to the two DMG assets on the `v0.1.0` release
- Link to the Releases page for later versions
- Note that builds are unsigned: first launch requires right-click → Open

Keep the existing **Build** section for developers compiling from source.

## Process

1. Install both Rust Apple Darwin targets if missing
2. Produce both release DMGs with Tauri
3. Create GitHub Release `v0.1.0` with both DMGs and a short release notes body
4. Update README Download links to the release asset URLs
5. Commit and push the README change only (no binary artifacts in the repo)

## Out of scope

- Code signing and notarization
- CI / tag-triggered builds
- Universal binary
- Committing DMGs into a repository directory
- Version bump beyond `0.1.0`

## Success criteria

- Release `v0.1.0` exists and lists both DMGs
- README Download section links work for Apple Silicon and Intel
- Gatekeeper workaround is documented
- Git history does not contain the DMG binaries
