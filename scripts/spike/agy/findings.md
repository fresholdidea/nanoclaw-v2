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

### Conversation ID
- **Emitted on stdout:** no. **Emitted on stderr:** no. **Filesystem-only:** yes.
- **Discovery mechanism:** new directory appears under `~/.gemini/antigravity-cli/brain/<uuid>/` and an entry is written to `~/.gemini/antigravity-cli/cache/last_conversations.json` keyed by the agent's cwd:
  ```json
  "/tmp/tmp.TD9VYo5WgC": "e7578d42-16d5-41df-936e-be5f5bc1ac4d"
  ```
  The cwd-keyed cache is the cleanest discovery path for the provider — give each session a unique cwd (we already do, per-session workspace mount) and read the cache after the first turn completes.
- **Note on directory:** the CLI uses `~/.gemini/antigravity-cli/` — NOT `~/.gemini/antigravity/` (which belongs to the desktop app). My first probe pass watched the wrong folder and saw no changes; corrected in the committed script.
- **ID format:** UUID v4 (sample: `e7578d42-16d5-41df-936e-be5f5bc1ac4d`).
- **Resume works:** yes. Turn 1: `Say hi in three words.` → `Hello there, user.` Turn 2 with `--conversation <id>`: `What did you just say?` → `Hello there, user. / I said, "Hello there, user."` — turn 2 saw turn 1.
- **Invalid-conversation behavior:**
  - Error text (verbatim, first line of stdout): `Warning: conversation "does-not-exist-12345" not found.`
  - Channel: **stdout**, not stderr.
  - Exit code: **0** (agy silently falls through and starts a fresh conversation — does NOT error out).
  - Regex candidate for `isSessionInvalid` (Phase 2 Task 2.4): `/^Warning: conversation ".*" not found\.$/m`
  - Implication: the provider cannot rely on exit code to detect session-invalid; it MUST scan stdout for this warning string and treat it as "fall back to fresh session" rather than letting agy auto-create one and lose continuation state on the host side.

## Decision

| Outcome | Action |
|---|---|
| Gate 1 fails (no Linux binary) | DEFER — Phase 2 skipped, revisit when Google ships. End spike branch. |
| Gate 1 passes, Gate 2a passes (stream + parseable) | PROCEED — Phase 2 CLI-per-turn pattern. |
| Gate 1 passes, Gate 2a fails, Gate 2c shows usable agentapi | PROCEED — Phase 2 server pattern (opencode-style). |
| Gate 1 passes, both 2a and 2c fail | DEFER — accept the cost or revisit when agy ships a streaming mode. |

**Selected:** PROCEED
**Implementation variant:** CLI-per-turn (Task 2.5 base path; agentapi alternate not needed)
**Rationale:** Gate 1 PASSED — verified Linux arm64 binary runs in `node:22-slim`. Gate 2a PASSED — agy `-p` emits stdout incrementally (narration + final answer); treating any stdout byte as an activity ping plus a 5s heartbeat from a sidecar timer covers the worst observed silence (122s tool-internal wait). No need to fall back to agentapi.

## Plan deltas required before Phase 2

Three corrections that must land in `docs/superpowers/plans/2026-05-25-agy-provider.md` and the matching code before Phase 2 implementation begins:

1. **Path correction.** Plan uses `~/.gemini/antigravity/` (desktop app) throughout. Real CLI path is `~/.gemini/antigravity-cli/`. Affects Task 2.5 constants (`BRAIN_DIR`, `MCP_CONFIG_PATH`) and Task 2.7 host mount (`DEFAULT_GEMINI_DIR` is fine but the in-container env vars need the `-cli` suffix).
2. **Conv-ID discovery.** Plan uses brain/-folder diff. Prefer reading `~/.gemini/antigravity-cli/cache/last_conversations.json` (cwd-keyed JSON map) — no race window, no polling. Brain/-folder diff is still a viable fallback.
3. **isSessionInvalid mechanics.** Invalid `--conversation` does NOT error — agy exits 0 with `Warning: conversation "<id>" not found.` on stdout and silently starts a fresh conversation. Provider must:
   - Either pre-check `brain/<id>/` exists before spawning (cheap, race-free)
   - Or scan stdout for `/^Warning: conversation ".*" not found\.$/m` mid-stream and treat it as session-invalid (clear `activeConversationId`, fail loudly so caller can retry without continuation)
