# Agy spike findings

Date started: 2026-05-25
Branch: spike/agy-provider

## Gate 1 — Linux binary

- **Available:** yes
- **linux/arm64 URL:** https://storage.googleapis.com/antigravity-public/antigravity-cli/1.0.2-6109799369277440/linux-arm/cli_linux_arm64.tar.gz
  - sha512: `1cbd300794617da091e8f10b40cd555727e50dcadaa60f275a873b7ab4ff5868bfeb12812da012be878fde79407c89a8a1ff3eeb4f1c50e26834d4e01bc073d7`
- **linux/amd64 URL:** https://storage.googleapis.com/antigravity-public/antigravity-cli/1.0.2-6109799369277440/linux-x64/cli_linux_x64.tar.gz
  - sha512: `131f5f38304082936f81ec8fda9aa3911231090f5aa3b27ead57c3de5d95c0ef95b281a6c02d81cb82beb8498455004fdbb62f0f09273d5c84bbb5e7a0f33086`
- **Download mechanism:** Google's auto-updater Cloud Run service at `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app` exposes per-platform JSON manifests at `/manifests/<platform>.json`. The manifest returns `{version, url, sha512}` where `url` points at a public bucket `storage.googleapis.com/antigravity-public/...`. Direct CDN download is unauthenticated; sha512 is published alongside.
- **Pinned version planned:** 1.0.2 (current stable per `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/` — "Stable Version: 1.0.2. Rolled out to 100%")
- **Platforms supported by the manifest system** (from the host binary's protobuf descriptors and `install.sh`):
  - `darwin_arm64`, `darwin_amd64`
  - `linux_arm64`, `linux_amd64`
  - `linux_arm64_musl`, `linux_amd64_musl` (Alpine/musl variants — relevant if container base ever changes from `node:22-slim`)
  - `windows_x64`
- **Evidence sources:**
  - Host binary strings revealed the auto-updater URL and CRC field names (`crc32c_linux_arm`, `crc32c_linux_x64`, etc.)
  - `install.sh` fetched from `https://antigravity.google/cli/install.sh` documents platform detection and manifest schema
  - Direct fetch of `/manifests/linux_arm64.json` and `/manifests/linux_amd64.json` returned valid JSON with download URLs and checksums (no auth required)
  - Companion docs repo at `github.com/google-antigravity/antigravity-cli` (CHANGELOG only — no release artifacts hosted there)
- **TODO (deferred to controller approval):**
  - [ ] Step 4: download `cli_linux_arm64.tar.gz`, verify sha512, extract `agy` binary
  - [ ] Step 5: bind-mount the extracted binary into a `node:22-slim` container and verify it runs (`agy --help`, glibc compatibility)

**Verdict: PASS (pending download verification)**

## Gate 2 — Headless streaming
TBD

## Decision
TBD
