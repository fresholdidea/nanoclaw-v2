# NanoClaw usage with ccusage

NanoClaw stores Claude, Codex, and OpenCode state inside `data/v2-sessions/`
instead of the host user's default CLI directories. The repository includes a
launcher that adds every existing NanoClaw agent group's provider data to
`ccusage` while retaining the normal host-wide sources.

From this checkout, run:

```bash
pnpm ccusage -- daily
```

Or use the PATH-friendly launcher:

```bash
./bin/ccusage daily
```

That is the combined host + NanoClaw report. To see NanoClaw's contribution as
its own total, use the `nanoclaw` launcher namespace:

```bash
./bin/ccusage nanoclaw daily --since 20260701 --until 20260731
```

The `nanoclaw` form isolates ccusage's home directory and passes only
NanoClaw's discovered provider roots. This is the number to compare against a
host-only `ccusage daily` report; the normal combined report intentionally does
not label the same Claude/Codex source as “host” versus “NanoClaw”.

The launcher passes through all `ccusage` arguments. With current `ccusage`
versions, `daily` (and the other unified reports) includes all supported
sources by default, so NanoClaw Claude, Codex, and OpenCode usage is included
alongside regular host usage. Focused reports also work, for example:

```bash
./bin/ccusage claude daily --breakdown
./bin/ccusage codex monthly
./bin/ccusage opencode session
```

NanoClaw's historical Claude transcript rotation used a `.jsonl.rotated-*`
suffix that `ccusage` does not recognize. The launcher builds a temporary,
read-only hard-link view with `.jsonl` names for those files; source
transcripts are never renamed or modified. If the temporary directory is on a
different filesystem, it falls back to a private temporary copy. The view is
removed when `ccusage` exits.

Gemini CLI usage is supported by ccusage through its normal `GEMINI_DATA_DIR`
source and remains included in the combined report. NanoClaw's Google
Antigravity (`agy`) provider writes to the shared
`~/.gemini/antigravity-cli` directory. The launcher passes that directory as
`ANTIGRAVITY_DATA_DIR` for ccusage builds that support the Antigravity source;
the installed ccusage 20.0.20 on this machine does not expose that source yet,
so it will not count Agy until ccusage is upgraded to a build with
Antigravity support. Because Agy state is shared across host and containers,
its data cannot currently be separated into a NanoClaw-only subtotal.

Existing `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `OPENCODE_DATA_DIR`, and
`ANTIGRAVITY_DATA_DIR` values are preserved and NanoClaw paths are appended.
Set `CCUSAGE_BIN` if the installed
binary is not named `ccusage` or is not on `PATH`.
