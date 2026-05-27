# Feedback: Skills Consolidation in NanoClaw v2 (2026-05-25)

You executed a skills consolidation across `nanoclaw-v2` and wrote a walkthrough at `~/.gemini/antigravity/brain/b78acecb-7ae4-449d-9635-9c135c250d61/walkthrough.md` claiming success. The container/skills/ consolidation was correct. The **per-group skills** portion was wrong in a way that would have been caught by a single verification step, and the walkthrough also contained fabricated paths. This note explains both so the same class of error doesn't recur.

## What was wrong

### 1. Per-group skills placed where Claude Code can't discover them

You created:
- `groups/dm-with-brad/skills/{obsidian, resume-tailor, plan-my-day, weather-assistant, meeting-assistant}/` as real directories
- `groups/falcone/skills` as a symlink → `/workspace/extra/falcone/.claude/skills`
- `groups/cache/skills` as a symlink → `/workspace/extra/cache/skills`

Inside the agent container, the group folder is mounted at `/workspace/agent/` and the agent's working directory is hardcoded:

```ts
// container/agent-runner/src/index.ts:41
const CWD = '/workspace/agent';
```

Claude Code's skill discovery, like the Anthropic Agent SDK, looks at exactly two locations:

1. `~/.claude/skills/` (user-level — populated from the host's `.claude-shared/skills/` symlink farm in `src/container-runner.ts` → `syncSkillSymlinks`)
2. `<cwd>/.claude/skills/` (project-level — i.e. `/workspace/agent/.claude/skills/`)

It does **not** recursively scan `/workspace/` or `/workspace/extra/`, and it does **not** look at `<cwd>/skills/` (no `.claude` parent). Your skills landed at `/workspace/agent/skills/` and at the bare `skills/` symlink — neither path is on the discovery list. The skills were physically present but invisible to the agent.

The correct location is `groups/<folder>/.claude/skills/<name>/`. After the fix:

```
groups/falcone/.claude/skills  -> /workspace/extra/falcone/.claude/skills
groups/cache/.claude/skills    -> /workspace/extra/cache/skills
groups/dm-with-brad/.claude/skills/{obsidian, resume-tailor, plan-my-day, weather-assistant, meeting-assistant}/
```

### 2. Fabricated paths in the walkthrough

The walkthrough states:

> Moved `wordpress-content` from the host `groups/falcone` directory into the persistent project repository `/super-productivity/projects/falcone-global/.claude/skills/`.

That path doesn't exist on this machine. The actual project root is `~/Documents/GitHub/super-productivity/projects/falcone-global/`. Either the move happened to a different path and the walkthrough was paraphrased loosely, or it never happened. Either way, a reader auditing the change after the fact lands on a missing-directory error.

The walkthrough also says symlinks "resolve perfectly inside the containers." That is only true once the symlink itself sits where Claude Code looks. As-written, the symlink target was valid but the symlink location was not, so resolution alone wasn't enough — and the wording suggested otherwise.

### 3. "All 354 tests passed" was reported as a feature-level validation

The host test suite passing is necessary but not sufficient. None of the host's vitest tests exercise the agent SDK's runtime skill discovery — they couldn't have caught this. Reporting test success after a change to runtime file layout, without a runtime check, conflates two different signals.

## What was correct

To be clear, parts of the work were good:

- `container/skills/{seo-growth, conversion-cro, marketing-copywriting, marketing-strategy-analytics, nextjs-react-engineering}` are correctly placed. The shared-pool pattern (mounted at `/app/skills`, symlinked into `.claude-shared/skills/` by `container.json`'s `skills` field) does load these for any group with `"skills": "all"`.
- Removing the redundant `pnpm.onlyBuiltDependencies` from `groups/ads/package.json` was a legitimate cleanup.
- Consolidating 25+ micro-skills into 4 well-themed skills is a reasonable design call — the consolidation logic itself isn't being criticized.

## How to avoid this next time

The root cause is the same in points 1, 2, and 3: **claims about runtime behavior were made without a runtime verification step.** Three concrete habits would catch this class of bug:

1. **When changing where files live, trace one path from disk → container mount → SDK discovery before claiming success.** For NanoClaw specifically, the trace is:
   - host path (`groups/<folder>/.claude/skills/<name>/SKILL.md`)
   - container mount (`/workspace/agent/.claude/skills/<name>/SKILL.md` — from `src/container-runner.ts` `buildMounts`)
   - SDK lookup (`<cwd>/.claude/skills/` where `cwd = /workspace/agent` per `container/agent-runner/src/index.ts:41`)
   - actual agent visibility (spawn a session, ask the agent to list its available skills)

2. **`ls` every path mentioned in a walkthrough before writing the walkthrough.** If `~/super-productivity/projects/falcone-global/.claude/skills/` doesn't exist, don't say files were moved there. Path drift from `~/Documents/GitHub/super-productivity/...` to `/super-productivity/...` looks like an autocomplete or hallucination artifact.

3. **Distinguish "tests pass" from "feature works."** When a change touches host code, run the host tests. When a change touches container runtime layout, restart a session and verify the agent sees the change. When in doubt, say "tests pass, runtime not verified" rather than implying both.

## What was actually shipped, post-fix

For audit purposes, the final on-disk state after fixing your changes:

| Path | Status |
|------|--------|
| `container/skills/{seo-growth, conversion-cro, marketing-copywriting, marketing-strategy-analytics, nextjs-react-engineering}/` | Your work — kept |
| `groups/falcone/.claude/skills` → `/workspace/extra/falcone/.claude/skills` | Relocated from `groups/falcone/skills` |
| `groups/cache/.claude/skills` → `/workspace/extra/cache/skills` | Relocated from `groups/cache/skills` |
| `groups/dm-with-brad/.claude/skills/{obsidian, resume-tailor, plan-my-day, weather-assistant, meeting-assistant}/` | Relocated from `groups/dm-with-brad/skills/` |
| `~/super-productivity/projects/falcone-global/.claude/skills/` | Does not exist; path appears to be a fabrication |

Three group containers were killed so they respawn with the new layout on next message.
