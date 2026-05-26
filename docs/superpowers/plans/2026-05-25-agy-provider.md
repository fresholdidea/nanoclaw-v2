# Agy Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `agy` (Google Antigravity CLI) as a fourth NanoClaw agent provider so any agent group can opt in via `agent_provider: 'agy'` and consume Google AI Pro subscription tokens.

**Architecture:** Two phases with a hard decision gate between them. Phase 1 is a spike that answers two unknowns (Linux binary, headless streaming) — its only deliverable is `scripts/spike/agy/findings.md`. Phase 2 is the production provider, modeled on `container/agent-runner/src/providers/opencode.ts` for the container side and `src/providers/opencode.ts` for the host side. Self-registration via existing registries — no factory edits needed.

**Tech Stack:** TypeScript (host: Node + pnpm, container: Bun), Docker (`node:22-slim` base), existing `AgentProvider` interface from `container/agent-runner/src/providers/types.ts`, host registries `provider-container-registry.ts` and `provider-registry.ts`, vitest (host) + bun:test (container).

**Spec:** `docs/superpowers/specs/2026-05-25-agy-provider-design.md` (commit `25f0ca8`).

---

## File Structure

### Phase 1 — Spike (throwaway, never shipped)

```
scripts/spike/agy/
├── 00-binary-check.sh        # Gate 1: confirm Linux build exists, download
├── 01-print-stream.sh        # Gate 2a: stdout streaming behavior of `agy -p`
├── 02-conversation-id.sh     # Gate 2b: how conversation ID is emitted on first run
├── 03-agentapi-probe.sh      # Gate 2c: probe agentapi binary for JSON-RPC
└── findings.md               # observations + decision (proceed/defer/skip)
```

All scripts disposable. `findings.md` is the only artifact that matters; it gets committed for the decision record.

### Phase 2 — Provider (only if gate passes)

```
container/agent-runner/src/providers/
├── agy.ts                    # AgentProvider implementation (NEW)
├── mcp-to-agy.ts             # MCP server config translator (NEW)
├── mcp-to-agy.test.ts        # unit tests for the translator (NEW)
├── agy.factory.test.ts       # registry/factory test (NEW)
└── index.ts                  # append loadProvider('agy') (MODIFY)

src/providers/
├── agy.ts                    # host-side container config (mounts, env) (NEW)
└── index.ts                  # append import './agy.js' (MODIFY)
```

No changes to:
- `container/agent-runner/src/providers/factory.ts` — uses the registry, no switch
- `container/agent-runner/src/providers/provider-registry.ts` — generic
- `container/agent-runner/src/providers/types.ts` — interface unchanged
- `src/providers/provider-container-registry.ts` — generic

---

## Phase 1: Spike Tasks

Each task ends with one or more lines appended to `scripts/spike/agy/findings.md`. No production code in Phase 1.

---

### Task 1.0: Branch and scaffold

**Files:**
- Create: `scripts/spike/agy/findings.md` (skeleton)

- [ ] **Step 1: Branch off `local/main`**

```bash
git checkout -b spike/agy-provider local/main
mkdir -p scripts/spike/agy
```

- [ ] **Step 2: Create findings skeleton**

Write `scripts/spike/agy/findings.md`:

```markdown
# Agy spike findings

Date started: 2026-05-25
Branch: spike/agy-provider

## Gate 1 — Linux binary
TBD

## Gate 2 — Headless streaming
TBD

## Decision
TBD
```

- [ ] **Step 3: Commit scaffold**

```bash
git add scripts/spike/agy/findings.md
git commit -m "spike(agy): scaffold spike branch + findings doc"
```

---

### Task 1.1: Gate 1 — Linux binary availability

**Files:**
- Create: `scripts/spike/agy/00-binary-check.sh`
- Modify: `scripts/spike/agy/findings.md`

- [ ] **Step 1: Write the check script**

Write `scripts/spike/agy/00-binary-check.sh`:

```bash
#!/usr/bin/env bash
# Goal: determine if Google ships agy for linux/arm64 (Docker on Apple Silicon)
# and/or linux/amd64. Record findings, do NOT auto-download.
set -euo pipefail

echo "=== Host agy ==="
which agy || true
file "$(which agy)" 2>/dev/null || true
agy --help 2>&1 | head -5

echo
echo "=== Update channel hints ==="
agy update --help 2>&1 | head -30 || true

echo
echo "=== Install/changelog subcommands ==="
agy install --help 2>&1 | head -20 || true
agy changelog 2>&1 | head -20 || true

echo
echo "=== Look for an install script or download manifest ==="
# Common patterns:
#   - vendor-shipped install.sh that detects arch
#   - GitHub releases (search 'antigravity-cli' on github)
#   - Google internal CDN URLs in agy --version or strings output
strings "$(which agy)" 2>/dev/null | grep -iE 'download|release|cdn|linux|arm64|amd64' | head -20 || true
```

- [ ] **Step 2: Run the script and capture output**

```bash
chmod +x scripts/spike/agy/00-binary-check.sh
bash scripts/spike/agy/00-binary-check.sh 2>&1 | tee /tmp/agy-binary-check.log
```

- [ ] **Step 3: Determine availability**

Decision tree:
1. If `agy update --help` shows arch-specific download URLs → record them
2. Else if strings output reveals a CDN URL pattern → curl it for `linux/arm64`
3. Else web-search "Antigravity CLI Linux release" / `site:github.com antigravity-cli`
4. Else open `~/.local/bin/agy` strings for download hints

Record in `findings.md` under "Gate 1":
- Available: yes/no
- linux/arm64 URL: <url or "not found">
- linux/amd64 URL: <url or "not found">
- Download mechanism: <`agy update`, direct CDN, GitHub release, etc.>
- Pinned version planned: <e.g., 1.2.3>

- [ ] **Step 4: If available, download arm64 to a local path**

```bash
# Example — adapt to real URL discovered in step 3
mkdir -p ~/.local/bin
curl -L -o ~/.local/bin/agy-linux-arm64 "<URL>"
chmod +x ~/.local/bin/agy-linux-arm64
file ~/.local/bin/agy-linux-arm64    # Expected: ELF 64-bit LSB, ARM aarch64
```

Record the path in `findings.md`.

- [ ] **Step 5: Verify the binary runs in the container base**

```bash
docker run --rm -v ~/.local/bin/agy-linux-arm64:/usr/local/bin/agy \
  node:22-slim /usr/local/bin/agy --help 2>&1 | head -10
```

Expected: help text identical to host `agy --help`.

If it errors (missing libc, etc.), record the error in `findings.md` and STOP — Gate 1 has failed.

- [ ] **Step 6: Update findings**

Append to `findings.md` under Gate 1 a one-line verdict: `PASS`, `FAIL`, or `BLOCKED`.

- [ ] **Step 7: Commit**

```bash
git add scripts/spike/agy/00-binary-check.sh scripts/spike/agy/findings.md
git commit -m "spike(agy): gate 1 — linux binary availability check"
```

---

### Task 1.2: Gate 2a — Stdout streaming behavior

**Files:**
- Create: `scripts/spike/agy/01-print-stream.sh`
- Modify: `scripts/spike/agy/findings.md`

Skip this task if Gate 1 failed.

- [ ] **Step 1: Write the streaming probe**

Write `scripts/spike/agy/01-print-stream.sh`:

```bash
#!/usr/bin/env bash
# Goal: determine whether `agy -p` emits stdout incrementally during tool
# execution, or buffers everything until the final result. The host's
# idle-kill timer needs incremental events.
set -euo pipefail

AGY_BIN="${AGY_BIN:-$HOME/.local/bin/agy-linux-arm64}"
if [ ! -x "$AGY_BIN" ]; then
  AGY_BIN="$(which agy)"
fi

# Use a workspace that forces tool calls.
WORK=$(mktemp -d)
echo "line one" > "$WORK/foo.txt"
echo "line two" >> "$WORK/foo.txt"

PROMPT="Read foo.txt in the current directory using your file tool, then list its lines back to me numbered."

echo "=== Run with timestamps on every output line ==="
# `ts` (moreutils) or `awk` adds wallclock to each line. If gaps > 5s appear
# between the spawn and the final result, stdout is buffered.
cd "$WORK"
"$AGY_BIN" -p "$PROMPT" \
  --dangerously-skip-permissions \
  --print-timeout 5m 2>&1 \
  | awk '{ printf "[%s] %s\n", strftime("%H:%M:%S"), $0; fflush(); }' \
  | tee /tmp/agy-stream.log

echo
echo "=== Test 2: check for --output-format json / similar ==="
"$AGY_BIN" --help 2>&1 | grep -iE 'output|format|json|stream' || echo "no format flags surfaced"
```

- [ ] **Step 2: Run and observe**

```bash
chmod +x scripts/spike/agy/01-print-stream.sh
bash scripts/spike/agy/01-print-stream.sh
```

Watch the timestamps. Key questions:
- Do tool-call lines appear before the final answer, or all at once at the end?
- Is there any JSON structure on stdout (or stderr) we can parse?
- Are there explicit `event:` / `tool:` / `assistant:` line prefixes?

- [ ] **Step 3: Record observations**

Append to `findings.md` under "Gate 2 — Headless streaming → Stdout":

```markdown
### Stdout streaming
- Incremental: yes/no
- Gap between first and last output: <Ns>
- Structured output mode: <found / not found>
- Line shape: <example lines>
- Parseable for activity pings: yes/no
```

- [ ] **Step 4: Commit**

```bash
git add scripts/spike/agy/01-print-stream.sh scripts/spike/agy/findings.md
git commit -m "spike(agy): gate 2a — stdout streaming behavior"
```

---

### Task 1.3: Gate 2b — Conversation ID emission

**Files:**
- Create: `scripts/spike/agy/02-conversation-id.sh`
- Modify: `scripts/spike/agy/findings.md`

- [ ] **Step 1: Write the conversation-id probe**

Write `scripts/spike/agy/02-conversation-id.sh`:

```bash
#!/usr/bin/env bash
# Goal: determine the format and emission point of the conversation ID
# that maps to the `continuation` token in the AgentProvider interface.
set -euo pipefail

AGY_BIN="${AGY_BIN:-$HOME/.local/bin/agy-linux-arm64}"
if [ ! -x "$AGY_BIN" ]; then
  AGY_BIN="$(which agy)"
fi

BRAIN_DIR="$HOME/.gemini/antigravity/brain"
BEFORE=$(ls "$BRAIN_DIR" 2>/dev/null | sort)

echo "=== Single turn: capture all output ==="
WORK=$(mktemp -d)
cd "$WORK"
"$AGY_BIN" -p "Say hi in three words." --dangerously-skip-permissions 2>&1 | tee /tmp/agy-convid.log

echo
echo "=== Diff brain/ folder to find the new conversation id ==="
AFTER=$(ls "$BRAIN_DIR" 2>/dev/null | sort)
NEW_CONVS=$(comm -13 <(echo "$BEFORE") <(echo "$AFTER"))
echo "New conversation folders:"
echo "$NEW_CONVS"

echo
echo "=== Second turn: resume by --conversation <id> ==="
if [ -n "$NEW_CONVS" ]; then
  FIRST=$(echo "$NEW_CONVS" | head -1)
  echo "Resuming $FIRST"
  "$AGY_BIN" -p "What did you just say?" \
    --conversation "$FIRST" \
    --dangerously-skip-permissions 2>&1 | tee /tmp/agy-resume.log
fi
```

- [ ] **Step 2: Run and observe**

```bash
chmod +x scripts/spike/agy/02-conversation-id.sh
bash scripts/spike/agy/02-conversation-id.sh
```

Three things to record:
1. Does the conversation ID appear in stdout/stderr of the first run?
2. If not, can we discover it from the `brain/` folder diff (filesystem watch)?
3. Does `--conversation <id>` actually resume context (the second turn references the first)?

- [ ] **Step 3: Probe error text for an invalid conversation**

```bash
"$AGY_BIN" -p "hello" --conversation "does-not-exist-12345" \
  --dangerously-skip-permissions 2>&1 | tee /tmp/agy-bad-conv.log
```

Record the error message verbatim — this becomes the `isSessionInvalid` regex.

- [ ] **Step 4: Record observations**

Append to `findings.md` under "Gate 2 — Headless streaming → Conversation ID":

```markdown
### Conversation ID
- Emitted on stdout: yes/no (sample: <line>)
- Discoverable via brain/ folder diff: yes/no
- ID format: <UUID / opaque string / etc.>
- Resume works: yes/no (does second turn see first?)
- Invalid-conversation error text: <exact line>
```

- [ ] **Step 5: Commit**

```bash
git add scripts/spike/agy/02-conversation-id.sh scripts/spike/agy/findings.md
git commit -m "spike(agy): gate 2b — conversation id format and resume"
```

---

### Task 1.4: Gate 2c — agentapi probe (optional)

**Files:**
- Create: `scripts/spike/agy/03-agentapi-probe.sh`
- Modify: `scripts/spike/agy/findings.md`

Only run if Gate 2a shows stdout is unfriendly (buffered, unstructured). If 2a is fine, skip this and note "not needed" in findings.

- [ ] **Step 1: Write the agentapi probe**

Write `scripts/spike/agy/03-agentapi-probe.sh`:

```bash
#!/usr/bin/env bash
# Goal: determine whether ~/.gemini/antigravity/bin/agentapi exposes a usable
# JSON-RPC / agent-protocol interface that would beat parsing CLI stdout.
set -euo pipefail

API_BIN="$HOME/.gemini/antigravity/bin/agentapi"
if [ ! -x "$API_BIN" ]; then
  echo "agentapi not present at $API_BIN"
  exit 0
fi

file "$API_BIN"
"$API_BIN" --help 2>&1 | head -40 || true
"$API_BIN" -h 2>&1 | head -40 || true

# Common JSON-RPC introspection: send `{"jsonrpc":"2.0","id":1,"method":"initialize"}`
# on stdin and see what comes back on stdout.
echo
echo "=== Stdin probe: initialize ==="
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  | timeout 5 "$API_BIN" 2>&1 | head -20 || true
```

- [ ] **Step 2: Run**

```bash
chmod +x scripts/spike/agy/03-agentapi-probe.sh
bash scripts/spike/agy/03-agentapi-probe.sh 2>&1 | tee /tmp/agy-agentapi.log
```

- [ ] **Step 3: Record observations**

Append to `findings.md` under "Gate 2 → agentapi":

```markdown
### agentapi
- Binary type: <Mach-O arm64 / ELF arm64 / not present>
- Surfaces help text: yes/no
- JSON-RPC initialize response: <yes (paste excerpt) / no / timeout>
- Verdict: usable / unusable / unknown
```

- [ ] **Step 4: Commit**

```bash
git add scripts/spike/agy/03-agentapi-probe.sh scripts/spike/agy/findings.md
git commit -m "spike(agy): gate 2c — agentapi probe"
```

---

### Task 1.5: Decision gate

**Files:**
- Modify: `scripts/spike/agy/findings.md`

- [ ] **Step 1: Write the decision section**

Based on the four observations, fill out the Decision section of `findings.md`:

```markdown
## Decision

| Outcome | Action |
|---|---|
| Gate 1 fails (no Linux binary) | DEFER — Phase 2 skipped, revisit when Google ships. End spike branch. |
| Gate 1 passes, Gate 2a passes (stream + parseable) | PROCEED — Phase 2 CLI-per-turn pattern. |
| Gate 1 passes, Gate 2a fails, Gate 2c shows usable agentapi | PROCEED — Phase 2 server pattern (opencode-style). |
| Gate 1 passes, both 2a and 2c fail | DEFER — accept the cost or revisit when agy ships a streaming mode. |

Selected: <PROCEED / DEFER / SKIP>
Implementation variant: <CLI-per-turn / agentapi-server / n/a>
Rationale: <one paragraph>
```

- [ ] **Step 2: Surface findings for human review**

Print `findings.md` and pause. A human must approve the decision before Phase 2 starts.

```bash
cat scripts/spike/agy/findings.md
```

- [ ] **Step 3: Commit the decision**

```bash
git add scripts/spike/agy/findings.md
git commit -m "spike(agy): decision — <PROCEED|DEFER>"
```

- [ ] **Step 4: Branch handling**

If DEFER or SKIP:
```bash
# Open a PR to merge the spike findings into local/main as a decision record,
# then close out the work.
gh pr create --title "spike(agy): defer agy provider — findings" \
  --body "$(cat scripts/spike/agy/findings.md)"
# Plan execution stops here.
```

If PROCEED: continue to Phase 2 on the same branch (rename it first).

```bash
git branch -m spike/agy-provider feat/agy-provider
```

---

## Phase 2: Provider Implementation (only if gate selects PROCEED)

Mirrors the `/add-opencode` pattern. TDD throughout. Tasks assume the **CLI-per-turn** variant was selected; if `agentapi` was selected, see the "Alternate: agentapi-server variant" section at the end and substitute Tasks 2.4–2.5 with the alternate code.

---

### Task 2.0: Branch verification

**Files:**
- None modified

- [ ] **Step 1: Confirm branch and findings**

```bash
git branch --show-current   # Expected: feat/agy-provider
test -f scripts/spike/agy/findings.md && grep -E '^Selected: PROCEED' scripts/spike/agy/findings.md
echo $?
```

Expected: exit 0. If not, stop and reconcile with Phase 1.

- [ ] **Step 2: Record the chosen Linux binary path**

Write the discovered binary path into an environment variable you'll use across the host file:

```bash
ls -la "$HOME/.local/bin/agy-linux-arm64"   # Should be ELF arm64, executable
```

If the path differs from `~/.local/bin/agy-linux-arm64`, the host provider code in Task 2.7 will need to be edited to match.

---

### Task 2.1: MCP translator — failing test

**Files:**
- Create: `container/agent-runner/src/providers/mcp-to-agy.test.ts`
- Test: same file

- [ ] **Step 1: Write the failing test**

Write `container/agent-runner/src/providers/mcp-to-agy.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { mcpServersToAgyConfig } from './mcp-to-agy.js';

describe('mcpServersToAgyConfig', () => {
  test('returns empty object when no servers configured', () => {
    expect(mcpServersToAgyConfig(undefined)).toEqual({});
  });

  test('maps a stdio server', () => {
    const result = mcpServersToAgyConfig({
      slack: {
        command: '/usr/local/bin/slack-mcp',
        args: ['--mode', 'http'],
        env: { TOKEN: 'placeholder' },
      },
    });
    expect(result).toEqual({
      slack: {
        command: '/usr/local/bin/slack-mcp',
        args: ['--mode', 'http'],
        env: { TOKEN: 'placeholder' },
      },
    });
  });

  test('maps an http server', () => {
    const result = mcpServersToAgyConfig({
      remote: {
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { 'X-Key': 'abc' },
      },
    });
    expect(result).toEqual({
      remote: {
        httpUrl: 'https://example.com/mcp',
        headers: { 'X-Key': 'abc' },
      },
    });
  });

  test('omits env field when empty', () => {
    const result = mcpServersToAgyConfig({
      bare: { command: 'echo', args: [], env: {} },
    });
    expect(result.bare).toEqual({ command: 'echo', args: [] });
  });
});
```

> **Why this shape:** agy's MCP config (`~/.gemini/antigravity-cli/mcp_config.json`) uses Google's GenAI MCP schema: stdio servers are `{command, args, env?}`; HTTP servers are `{httpUrl, headers?}`. (Spike Task 1.3 confirmed the CLI's data dir is `antigravity-cli/`, not `antigravity/` — that's the desktop app.)

- [ ] **Step 2: Run test to verify it fails**

```bash
cd container/agent-runner
bun test src/providers/mcp-to-agy.test.ts
```

Expected: FAIL with "Cannot find module './mcp-to-agy.js'".

---

### Task 2.2: MCP translator — implementation

**Files:**
- Create: `container/agent-runner/src/providers/mcp-to-agy.ts`

- [ ] **Step 1: Write the translator**

Write `container/agent-runner/src/providers/mcp-to-agy.ts`:

```ts
import type { McpServerConfig } from './types.js';

/** Agy `mcp_config.json` entry shape (Google GenAI MCP schema). */
export type AgyMcpLocal = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

export type AgyMcpRemote = {
  httpUrl: string;
  headers?: Record<string, string>;
};

export type AgyMcpEntry = AgyMcpLocal | AgyMcpRemote;

/**
 * Translate NanoClaw v2 MCP server definitions into the schema agy reads from
 * `~/.gemini/antigravity-cli/mcp_config.json`. The container provider writes
 * the full `{ mcpServers: ... }` envelope before each query.
 *
 * (Path is `antigravity-cli`, not `antigravity` — the unsuffixed dir is the
 * desktop app's data, not the CLI's. Verified in spike Task 1.3.)
 */
export function mcpServersToAgyConfig(
  servers: Record<string, McpServerConfig> | undefined,
): Record<string, AgyMcpEntry> {
  const out: Record<string, AgyMcpEntry> = {};
  if (!servers) return out;
  for (const [name, cfg] of Object.entries(servers)) {
    if ('url' in cfg) {
      out[name] = {
        httpUrl: cfg.url,
        ...(cfg.headers ? { headers: cfg.headers } : {}),
      };
    } else {
      out[name] = {
        command: cfg.command,
        args: cfg.args,
        ...(Object.keys(cfg.env).length > 0 ? { env: cfg.env } : {}),
      };
    }
  }
  return out;
}
```

- [ ] **Step 2: Run test to verify it passes**

```bash
cd container/agent-runner
bun test src/providers/mcp-to-agy.test.ts
```

Expected: PASS all 4 tests.

- [ ] **Step 3: Commit**

```bash
git add container/agent-runner/src/providers/mcp-to-agy.ts container/agent-runner/src/providers/mcp-to-agy.test.ts
git commit -m "feat(agy): mcp config translator + tests"
```

---

### Task 2.3: Provider — failing isSessionInvalid test

**Files:**
- Create: `container/agent-runner/src/providers/agy.factory.test.ts`

- [ ] **Step 1: Write the failing test**

Write `container/agent-runner/src/providers/agy.factory.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

describe('AgyProvider', () => {
  test('registers itself when imported', async () => {
    await import('./agy.js');
    const { getProviderFactory, listProviderNames } = await import('./provider-registry.js');
    expect(listProviderNames()).toContain('agy');
    const factory = getProviderFactory('agy');
    const instance = factory({});
    expect(instance.supportsNativeSlashCommands).toBe(false);
  });

  test('isSessionInvalid matches the agy-not-found error text', async () => {
    await import('./agy.js');
    const { getProviderFactory } = await import('./provider-registry.js');
    const provider = getProviderFactory('agy')({});
    // Exact warning agy emits on stdout for a missing --conversation id
    // (verified in spike Task 1.3 step 3). NOTE: agy exits 0 in this case
    // and silently falls through to a fresh conversation — the provider
    // scans stdout for this warning mid-stream and throws an error whose
    // message matches the regex so the agent-runner clears continuation.
    const NOT_FOUND_MSG = 'Warning: conversation "abc-123" not found.';
    expect(provider.isSessionInvalid(new Error(NOT_FOUND_MSG))).toBe(true);
    expect(provider.isSessionInvalid(new Error('something else entirely'))).toBe(false);
  });
});
```

> **Test text was set from spike Task 1.3 step 3:** `Warning: conversation "<id>" not found.` This is what agy prints to stdout when `--conversation <unknown-id>` is passed. agy then exits 0 and starts a fresh conversation — the provider's job is to detect this mid-stream and throw so the agent-runner can clear `continuation` and retry properly.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd container/agent-runner
bun test src/providers/agy.factory.test.ts
```

Expected: FAIL with "Cannot find module './agy.js'".

---

### Task 2.4: Provider — skeleton + isSessionInvalid

**Files:**
- Create: `container/agent-runner/src/providers/agy.ts`

This task creates a non-functional skeleton with just enough surface for the factory test. The `query()` implementation comes in Task 2.5.

- [ ] **Step 1: Write the skeleton**

Write `container/agent-runner/src/providers/agy.ts`:

```ts
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

function log(msg: string): void {
  console.error(`[agy-provider] ${msg}`);
}

/**
 * Stale-session detection. agy exits 0 when --conversation <id> is missing
 * and prints `Warning: conversation "<id>" not found.` on stdout, then
 * silently starts a fresh conversation. The provider scans stdout for this
 * warning and throws an error whose message matches this regex.
 * (Verified in spike Task 1.3 step 3.)
 */
const STALE_SESSION_RE = /Warning: conversation ".*" not found\./;

export class AgyProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly options: ProviderOptions;
  private activeConversationId: string | undefined;

  constructor(options: ProviderOptions = {}) {
    this.options = options;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  query(_input: QueryInput): AgentQuery {
    // Implemented in Task 2.5
    throw new Error('AgyProvider.query() not implemented yet');
  }
}

registerProvider('agy', (opts) => new AgyProvider(opts));
```

- [ ] **Step 2: Run test to verify it passes**

```bash
cd container/agent-runner
bun test src/providers/agy.factory.test.ts
```

Expected: PASS both tests.

- [ ] **Step 3: Commit**

```bash
git add container/agent-runner/src/providers/agy.ts container/agent-runner/src/providers/agy.factory.test.ts
git commit -m "feat(agy): provider skeleton + registry + isSessionInvalid"
```

---

### Task 2.5: Provider — query() implementation (CLI-per-turn)

**Files:**
- Modify: `container/agent-runner/src/providers/agy.ts`

Implements the `query()` method. Spawns `agy -p` per turn, parses stdout line-by-line for activity, watches the brain/ folder for the conversation ID on first run (per spike findings 1.3), and uses abort-and-restart for follow-up `push()` messages.

> **Variant note:** if spike findings 1.3 step 2 showed the conversation ID is emitted on stdout (e.g., on a line like `conversation_id: abc-123`), replace the brain/-folder watch with a simple regex on stdout. The variant code is in the "Alternate: stdout-emitted conv-id" section below.

- [ ] **Step 1: Replace the skeleton query() with the full implementation**

Open `container/agent-runner/src/providers/agy.ts` and replace the placeholder `query()` method (and add the necessary imports) so the file reads:

```ts
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';
import { mcpServersToAgyConfig } from './mcp-to-agy.js';

function log(msg: string): void {
  console.error(`[agy-provider] ${msg}`);
}

const STALE_SESSION_RE = /Warning: conversation ".*" not found\./;

const AGY_BIN = process.env.AGY_BIN || 'agy';
const CLI_DATA_DIR = process.env.AGY_CLI_DATA_DIR || '/home/node/.gemini/antigravity-cli';
const MCP_CONFIG_PATH = process.env.AGY_MCP_CONFIG_PATH || `${CLI_DATA_DIR}/mcp_config.json`;
const LAST_CONVS_PATH = process.env.AGY_LAST_CONVS_PATH || `${CLI_DATA_DIR}/cache/last_conversations.json`;
const PRINT_TIMEOUT = process.env.AGY_PRINT_TIMEOUT || '15m';

function writeMcpConfig(servers: ProviderOptions['mcpServers']): void {
  fs.mkdirSync(path.dirname(MCP_CONFIG_PATH), { recursive: true });
  const config = { mcpServers: mcpServersToAgyConfig(servers) };
  fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify(config, null, 2));
}

/**
 * Look up the conversation id agy associated with this cwd. agy writes the
 * cwd→uuid mapping to `cache/last_conversations.json` shortly after starting
 * a -p run. Race-free vs. the brain/ folder diff because the key is known.
 * (Verified in spike Task 1.3.)
 */
function getConvIdForCwd(cwd: string): string | null {
  try {
    const cache = JSON.parse(fs.readFileSync(LAST_CONVS_PATH, 'utf-8')) as Record<string, unknown>;
    const value = cache[cwd];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

export class AgyProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly options: ProviderOptions;
  private activeConversationId: string | undefined;

  constructor(options: ProviderOptions = {}) {
    this.options = options;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    if (input.continuation) {
      this.activeConversationId = input.continuation;
    }

    writeMcpConfig(this.options.mcpServers);

    const pending: string[] = [input.prompt];
    const self = this;
    let activeProc: ChildProcess | null = null;
    let aborted = false;
    let ended = false;
    let waiting: (() => void) | null = null;

    const kick = (): void => { waiting?.(); waiting = null; };

    function spawnTurn(text: string): ChildProcess {
      const args = ['-p', text, '--dangerously-skip-permissions', '--print-timeout', PRINT_TIMEOUT];
      if (self.activeConversationId) {
        args.push('--conversation', self.activeConversationId);
      }
      args.push('--add-dir', input.cwd);
      const env: Record<string, string> = { ...process.env } as Record<string, string>;
      return spawn(AGY_BIN, args, { cwd: input.cwd, env, detached: false });
    }

    async function* gen(): AsyncGenerator<ProviderEvent> {
      let initYielded = false;

      while (!aborted) {
        while (pending.length === 0 && !ended && !aborted) {
          await new Promise<void>((resolve) => { waiting = resolve; });
        }
        if (aborted || (pending.length === 0 && ended)) return;

        const turnText = pending.shift()!;
        const proc = spawnTurn(turnText);
        activeProc = proc;

        let stdoutBuf = '';
        let staleWarningDetected = false;

        // Stdout handler: collect lines, scan for the stale-conversation
        // warning. agy doesn't error when --conversation is missing — it
        // exits 0 after printing this warning and silently starts a fresh
        // conversation. We must abort the turn and surface as session-
        // invalid so the agent-runner clears the stored continuation.
        const lines: string[] = [];
        const errorChunks: string[] = [];
        const stdoutPromise = new Promise<void>((resolve, reject) => {
          proc.stdout?.on('data', (chunk: Buffer) => {
            const text = chunk.toString();
            stdoutBuf += text;
            const parts = stdoutBuf.split('\n');
            stdoutBuf = parts.pop() ?? '';
            for (const ln of parts) {
              lines.push(ln);
              if (STALE_SESSION_RE.test(ln)) {
                staleWarningDetected = true;
                try { proc.kill('SIGTERM'); } catch { /* ignore */ }
              }
            }
          });
          proc.stderr?.on('data', (chunk: Buffer) => {
            errorChunks.push(chunk.toString());
          });
          proc.on('close', (code) => {
            if (stdoutBuf) lines.push(stdoutBuf);
            if (staleWarningDetected) {
              const id = self.activeConversationId ?? '?';
              reject(new Error(`Warning: conversation "${id}" not found.`));
              return;
            }
            if (code !== 0 && !aborted) {
              reject(new Error(`agy exited ${code}: ${errorChunks.join('').slice(0, 500)}`));
            } else {
              resolve();
            }
          });
          proc.on('error', reject);
        });

        // Discover the conversation id on first turn via the cwd-keyed
        // last_conversations.json cache (see spike Task 1.3). Poll every
        // 500ms until the id appears or the process exits. The poll also
        // serves as activity-pings while we wait.
        if (!initYielded && !self.activeConversationId) {
          const start = Date.now();
          while (Date.now() - start < 30_000) {
            const id = getConvIdForCwd(input.cwd);
            if (id) {
              self.activeConversationId = id;
              yield { type: 'init', continuation: id };
              initYielded = true;
              break;
            }
            yield { type: 'activity' };
            await new Promise((r) => setTimeout(r, 500));
            if (proc.exitCode !== null) break;
          }
          if (!initYielded) {
            log('Failed to discover conversation id within 30s — proceeding without continuation');
          }
        } else if (!initYielded && self.activeConversationId) {
          yield { type: 'init', continuation: self.activeConversationId };
          initYielded = true;
        }

        // Heartbeat: yield activity at most every 5s while waiting for close.
        const heartbeat = (async function* () {
          while (proc.exitCode === null && !aborted) {
            yield { type: 'activity' as const };
            await new Promise((r) => setTimeout(r, 5000));
          }
        })();

        try {
          // Drain heartbeats in parallel with awaiting close.
          let closed = false;
          stdoutPromise.then(() => { closed = true; }).catch(() => { closed = true; });
          while (!closed && !aborted) {
            const { value, done } = await heartbeat.next();
            if (done) break;
            if (value) yield value;
          }
          await stdoutPromise;
        } catch (err) {
          self.activeConversationId = undefined;
          throw err;
        } finally {
          activeProc = null;
        }

        const resultText = lines.join('\n').trim();
        yield { type: 'result', text: resultText || null };
      }
    }

    return {
      push: (message: string) => {
        // CLI-per-turn pattern: aborting the current process and respawning
        // is the only way to inject a follow-up message into a `-p` run.
        pending.push(message);
        if (activeProc) {
          try { activeProc.kill('SIGTERM'); } catch { /* ignore */ }
        }
        kick();
      },
      end: () => {
        ended = true;
        kick();
      },
      events: gen(),
      abort: () => {
        aborted = true;
        if (activeProc) {
          try { activeProc.kill('SIGKILL'); } catch { /* ignore */ }
        }
        kick();
      },
    };
  }
}

registerProvider('agy', (opts) => new AgyProvider(opts));
```

- [ ] **Step 2: Typecheck**

```bash
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
```

Expected: no errors.

- [ ] **Step 3: Run existing tests (must still pass)**

```bash
cd container/agent-runner
bun test
```

Expected: all tests pass, including the previously-passing factory test.

- [ ] **Step 4: Commit**

```bash
git add container/agent-runner/src/providers/agy.ts
git commit -m "feat(agy): query() — spawn agy -p per turn, brain/-folder conv-id, heartbeat activity"
```

---

### Task 2.6: Container provider registration

**Files:**
- Modify: `container/agent-runner/src/providers/index.ts`

- [ ] **Step 1: Append the loader call**

Edit `container/agent-runner/src/providers/index.ts`. Change:

```ts
await Promise.all([
  loadProvider('claude'),
  loadProvider('mock'),
  loadProvider('opencode'),
]);
```

to:

```ts
await Promise.all([
  loadProvider('claude'),
  loadProvider('mock'),
  loadProvider('opencode'),
  loadProvider('agy'),
]);
```

- [ ] **Step 2: Run agent-runner tests**

```bash
cd container/agent-runner
bun test
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add container/agent-runner/src/providers/index.ts
git commit -m "feat(agy): register agy provider in agent-runner barrel"
```

---

### Task 2.7: Host-side container config

**Files:**
- Create: `src/providers/agy.ts`

- [ ] **Step 1: Write the host provider config**

Write `src/providers/agy.ts`:

```ts
/**
 * Host-side container config for the `agy` provider.
 *
 * Agy reads OAuth credentials from `~/.gemini/oauth_creds.json` and writes
 * CLI data (cache, brain, mcp_config) under `~/.gemini/antigravity-cli/`.
 * The desktop app uses `~/.gemini/antigravity/` — we mount the parent so
 * both are available, but only the `-cli` paths matter to the provider.
 *
 * The Linux binary is bind-mounted because we don't bake agy into the image —
 * users who never enable agy shouldn't carry the binary in their image.
 *
 * Real secrets never enter the container in env vars; the OAuth token file
 * is the auth surface, mounted from the host.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { registerProviderContainerConfig } from './provider-container-registry.js';

// Candidate paths for the Linux agy binary, in priority order.
// The binary inside the tarball is named `antigravity`, not `agy`.
// Override with AGY_LINUX_BIN env if you keep it elsewhere.
const DEFAULT_AGY_LINUX_BIN_CANDIDATES = [
  path.join(process.cwd(), 'scripts/spike/agy/cache/antigravity'),
  path.join(os.homedir(), '.local/bin/antigravity-linux-arm64'),
  path.join(os.homedir(), '.local/bin/agy-linux-arm64'),
];
const DEFAULT_GEMINI_DIR = path.join(os.homedir(), '.gemini');

function resolveAgyBin(envOverride?: string): string | null {
  if (envOverride) return fs.existsSync(envOverride) ? envOverride : null;
  for (const candidate of DEFAULT_AGY_LINUX_BIN_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

registerProviderContainerConfig('agy', (ctx) => {
  const agyBin = resolveAgyBin(ctx.hostEnv.AGY_LINUX_BIN);
  const geminiDir = ctx.hostEnv.AGY_GEMINI_DIR || DEFAULT_GEMINI_DIR;

  if (!agyBin) {
    throw new Error(
      `agy provider: Linux binary not found. Tried: ${DEFAULT_AGY_LINUX_BIN_CANDIDATES.join(', ')}. ` +
        `Set AGY_LINUX_BIN in the host env or download per docs/superpowers/specs/2026-05-25-agy-provider-design.md.`,
    );
  }
  if (!fs.existsSync(geminiDir)) {
    throw new Error(
      `agy provider: ${geminiDir} not found. Run \`agy\` on the host once to initialize and complete Google OAuth.`,
    );
  }

  return {
    mounts: [
      { hostPath: agyBin, containerPath: '/usr/local/bin/agy', readonly: true },
      { hostPath: geminiDir, containerPath: '/home/node/.gemini', readonly: false },
    ],
    env: {
      AGY_BIN: '/usr/local/bin/agy',
      AGY_CLI_DATA_DIR: '/home/node/.gemini/antigravity-cli',
      AGY_MCP_CONFIG_PATH: '/home/node/.gemini/antigravity-cli/mcp_config.json',
      AGY_LAST_CONVS_PATH: '/home/node/.gemini/antigravity-cli/cache/last_conversations.json',
    },
  };
});
```

- [ ] **Step 2: Append to the host barrel**

Edit `src/providers/index.ts`. Change:

```ts
import './opencode.js';
```

to:

```ts
import './opencode.js';
import './agy.js';
```

- [ ] **Step 3: Typecheck and host tests**

```bash
pnpm exec tsc --noEmit
pnpm test -- src/providers
```

Expected: typecheck clean, tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/providers/agy.ts src/providers/index.ts
git commit -m "feat(agy): host-side container config — mount binary + ~/.gemini"
```

---

### Task 2.8: Integration smoke test

**Files:**
- Modify: a chosen test agent group's `groups/<group>/container.json` (revert after test)

> **Pick a low-stakes agent group for this test.** Brad's `cache` group (selective OneCLI mode, marketing brain) is a reasonable choice since it has minimal MCP wiring and isn't on the hot path. Do NOT test against `dm-with-brad` (Zed) or `home`.

- [ ] **Step 1: Rebuild the container image**

```bash
./container/build.sh
```

Expected: build completes without errors. The image does NOT contain the agy binary — it gets mounted.

- [ ] **Step 2: Snapshot the chosen group's config**

```bash
cp groups/cache/container.json /tmp/cache-container-before.json
```

- [ ] **Step 3: Flip provider to agy**

Use `ncl` (preferred) or edit `container.json` directly:

```bash
ncl groups config update --id <cache-group-id> --set provider=agy
ncl groups restart --id <cache-group-id> --rebuild --message "smoke test — please respond with 'agy hello' and nothing else"
```

- [ ] **Step 4: Watch logs**

```bash
tail -f logs/nanoclaw.error.log logs/nanoclaw.log
```

Watch for:
- `[agy-provider]` log lines from the container
- An init event with a `continuation:` value
- A final result event

- [ ] **Step 5: Verify success criteria (per spec)**

Run through the spec's five success criteria:

1. **Single-turn response.** Channel received "agy hello"? ✓/✗
2. **Continuation works.** Send a second message (e.g., "what did you just say?"). Did it reference the first? ✓/✗
3. **Long-task tolerance.** Send: "spend 3 minutes reading every file under /workspace/agent/ and summarize." Did the container survive past the 2-minute idle threshold? ✓/✗
4. **MCP credentials.** If the cache group has any OneCLI-gated MCP server wired, confirm it still works. ✓/✗
5. **Cost lands on Google.** Open https://aistudio.google.com/usage or your Google AI billing dashboard. Confirm spend uptick. ✓/✗

Record results in a new section in `scripts/spike/agy/findings.md`:

```markdown
## Phase 2 smoke test (date)

| Criterion | Result | Notes |
|---|---|---|
| 1. Single-turn response | ✓ / ✗ | … |
| 2. Continuation | ✓ / ✗ | … |
| 3. Long-task tolerance | ✓ / ✗ | … |
| 4. OneCLI MCP creds | ✓ / ✗ | … |
| 5. Google billing | ✓ / ✗ | … |
```

- [ ] **Step 6: Restore the group's previous provider**

```bash
ncl groups config update --id <cache-group-id> --set provider=claude
ncl groups restart --id <cache-group-id>
```

Verify `container.json` matches `/tmp/cache-container-before.json` for the provider field.

- [ ] **Step 7: Commit findings**

```bash
git add scripts/spike/agy/findings.md
git commit -m "feat(agy): smoke test results"
```

---

### Task 2.9: PR + cleanup

- [ ] **Step 1: PR hygiene check (per CLAUDE.md)**

```bash
git diff upstream/main --stat HEAD
git log upstream/main..HEAD --oneline
```

Confirm the diff contains only:
- `scripts/spike/agy/` (findings + spike scripts)
- `container/agent-runner/src/providers/{agy.ts, mcp-to-agy.ts, mcp-to-agy.test.ts, agy.factory.test.ts}`
- `container/agent-runner/src/providers/index.ts` (one-line append)
- `src/providers/agy.ts`
- `src/providers/index.ts` (one-line append)
- `docs/superpowers/specs/2026-05-25-agy-provider-design.md`
- `docs/superpowers/plans/2026-05-25-agy-provider.md`

No installation-specific files (no group `container.json` changes, no `.claude/settings.json` edits).

- [ ] **Step 2: Open the PR**

```bash
git push -u origin feat/agy-provider
gh pr create --title "feat: agy as 4th agent provider" --body "$(cat <<'EOF'
## Summary
- Adds `agy` (Google Antigravity CLI) as a fourth NanoClaw agent provider.
- Mirrors the `/add-opencode` pattern: host-side mounts + env in `src/providers/agy.ts`, container-side `AgentProvider` impl in `container/agent-runner/src/providers/agy.ts`.
- Binary bind-mounted from host (`AGY_LINUX_BIN`); not baked into the image.

## Spike findings
See `scripts/spike/agy/findings.md` for the decision record and Phase 2 smoke test results.

## Test plan
- [ ] `pnpm test` (host)
- [ ] `cd container/agent-runner && bun test` (container)
- [ ] Smoke test on `cache` agent group (logged in findings)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Alternate: agentapi-server variant

If Phase 1 selected the `agentapi` JSON-RPC route instead of CLI-per-turn, replace Task 2.5 with this approach (skeleton — adapt to the actual `agentapi` interface discovered in spike 1.4):

1. Add a `spawnAgyServer()` helper modeled on `spawnOpencodeServer()` in `container/agent-runner/src/providers/opencode.ts:32-76`.
2. Maintain a shared runtime singleton like `sharedRuntime` in `opencode.ts:139-202` so multiple `query()` calls reuse one agentapi process.
3. In `query()`, send a JSON-RPC method (likely `prompt` / `message` — discovered in spike 1.4) and stream response events from stdout.
4. `push()` sends another JSON-RPC message on the same connection (no abort-restart needed).
5. `abort()` sends a `cancel` JSON-RPC if supported, otherwise kills the process.

Keep Tasks 2.0–2.4 and 2.6–2.9 identical — the public surface (registration, factory, mcp translator, host mount) doesn't change.

---

## Self-Review notes (writer's pre-handoff check)

- **Spec coverage:** All 5 success criteria → Task 2.8 smoke test. Two-gate spike → Tasks 1.1–1.5. Five "Open Questions" from spec → Tasks 1.1 (#1), 1.2 (#2), 1.4 (#3), 1.3 (#4 and #5).
- **Placeholder scan:** Two intentional fork points are flagged in-place — the `STALE_SESSION_RE` regex in Task 2.4 (replace with spike-captured text) and the variant-vs-CLI choice in Task 2.5 (alternate at bottom). Both are tagged "IMPORTANT" / "Variant note" and tied to specific spike outputs.
- **Type consistency:** `mcpServersToAgyConfig`, `AgentProvider`, `ProviderOptions`, `QueryInput`, `ProviderEvent`, `registerProvider`, `registerProviderContainerConfig` all match the existing definitions in `provider-registry.ts`, `types.ts`, and `provider-container-registry.ts`.
- **Group target:** Smoke test pinned to `cache` group with explicit "DO NOT use `dm-with-brad` or `home`" guard.
