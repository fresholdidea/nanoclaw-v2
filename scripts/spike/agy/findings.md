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
- **Download + extraction verified (2026-05-25):**
  - Downloaded `cli_linux_arm64.tar.gz` (46.7 MB) from the manifest URL above.
  - sha512 matched the manifest exactly (`1cbd300794617da091e8f10b40cd555727e50dcadaa60f275a873b7ab4ff5868bfeb12812da012be878fde79407c89a8a1ff3eeb4f1c50e26834d4e01bc073d7`).
  - Tarball contains a single file named `antigravity` (not `agy` or `cli`) at the root — extracted path: `scripts/spike/agy/cache/antigravity` (gitignored, 168 MB, executable bit set).
  - `file` output: `ELF 64-bit LSB pie executable, ARM aarch64, version 1 (SYSV), dynamically linked, interpreter /lib/ld-linux-aarch64.so.1, for GNU/Linux 3.7.0, BuildID[md5/uuid]=207bc3b130f20dc90d3ac6fa876c04e6, stripped`.
- **Container compat verified (2026-05-25):**
  - Bind-mounted the binary read-only into `node:22-slim` as `/usr/local/bin/agy` and ran `--help`.
  - Help text rendered cleanly — no glibc/loader errors. Confirmed flags include `--print`, `--prompt`, `--continue`, `--conversation`, `--dangerously-skip-permissions`, `--sandbox`, `--add-dir`, `--log-file`, `--print-timeout`, plus subcommands `changelog`, `help`, `install`, `plugin`/`plugins`, `update`.
  - glibc 3.7.0 minimum requirement is well below `node:22-slim`'s Debian Trixie glibc, so no compat surprise expected for the supported container base.
- **Note on binary name:** the tarball's executable is `antigravity`, not `agy`. The host's `agy` command (installed via `install.sh`) is a symlink/wrapper to `antigravity`. Provider integration should either rename the binary on install or invoke it as `antigravity` directly.

**Verdict: PASS**

## Gate 2 — Headless streaming

### Stdout streaming
- Incremental: yes
- Gap between first and last output: 167s total span across 27 lines; typical inter-line gap <2s. One 122s silence occurred while a long-running `find /` tool call executed (agent narrated "I will wait for the `find` command to complete..." immediately before the silence, confirming the gap is tool-execution time, not output buffering). All narration/action lines arrived before the final answer, not bundled at the end.
- Structured output mode: not found. `--help` exposes only `--print`, `--print-timeout`, `--log-file`, `--add-dir`, `--continue`, `--conversation`, `--dangerously-skip-permissions`, `--sandbox`, `-i/--prompt-interactive`. No `--output-format`, no `--json`, no `--stream` flag. Subcommands are `changelog`, `help`, `install`, `plugin`, `update` — none relevant.
- Line shape: each pre-tool-call line is a plain-text first-person narration of the upcoming action, e.g. `I will search for foo.txt on the filesystem to locate its path.` / `I will list the contents of /Users/bradhess to see what is in there.` Final answer lines arrive as normal prose (`Here are the lines of the file, numbered:` followed by `1. line one`, `2. line two`). No `event:` / `tool:` / `assistant:` prefixes. No JSON.
- Parseable for activity pings: yes for activity-ping purposes (any new line on stdout = liveness signal — sufficient to reset an idle-kill timer). No for structured event parsing (would need to LLM-classify lines, which we don't want). Recommendation: treat any stdout write as an activity ping; do not attempt to parse line semantics.

## Decision
TBD
