---
name: folder-audit
description: Audit a folder for size, similarity clusters, and staleness so it stays small enough for both humans and AI tools to navigate. Reflective — reads prior `.folder-audit.md` state and reports Resolved / New / Worsened across runs, skipping issues the user has already chosen to keep. Self-healing — proposes a reorg, applies it on approval, then updates state. Built for the failure mode where one folder grows to dozens of similar files until nobody (and no agent) can find what they need. Triggers on "audit folder", "audit this folder", "reorganize <path>", "folder is messy", "too many files in", "clean up <path>", "this directory is unwieldy".
allowed-tools: Bash Read Edit Write Glob Grep
---

# Folder Audit

## When to use

User points at a folder (or a tree) that has grown unwieldy — "too many notes in this directory", "I can't find anything in `Downloads/`", "clean up the wiki sources folder". Also: scheduled hygiene runs (weekly `/loop` or `/schedule`) over a fixed list of high-churn folders.

## Contract

**Input:** an absolute folder path. Optionally `--apply` (otherwise dry-run), `--recursive` (audit subfolders too), `--budget=N` (override file-count budget; default 25), `--stale-days=N` (default 180).

**Output:** a markdown report printed to chat AND written to `<path>/.folder-audit.md` in the audited folder. The state file is the memory across runs.

**Never** touch `.git/`, `node_modules/`, `.venv/`, build outputs, or anything inside a `.gitignore`d path. Treat dotfiles and dotfolders as load-bearing — list them but do not propose moving them.

## The three signals

### 1. Size (context budget)

Count files directly in the target folder (not recursive unless `--recursive`).

- **OK:** ≤ budget
- **Watch:** budget+1 … 2×budget
- **Exceeded:** > 2×budget — flag for reorg

Reasoning: an LLM that needs to `Glob` + `Read` to understand a folder pays linearly in file count. 25 files of ~10KB markdown ≈ 250KB ≈ ~70K tokens at worst. Anything over ~50 files in one directory means an agent will need to skim+sample instead of read fully.

### 2. Similarity clusters

For each set of ≥ 3 files in the folder, detect clusters by:

- **Filename prefix** — `meeting-2025-...`, `invoice-...`, `screenshot-...`. Common prefix ≥ 6 chars across ≥ 3 files.
- **Extension grouping** — ≥ 5 files of the same extension that aren't the folder's dominant type.
- **Inferred topic** — read the first ~500 bytes of text files (`.md`, `.txt`) and look for shared frontmatter tags, shared headings, or obvious topical overlap. Don't over-think this — if it isn't obvious, skip it.

For each cluster: propose a subfolder name and list its candidate files. **Do not** propose more than 3 new subfolders per audit — too much churn is worse than the original mess.

### 3. Staleness

A file is stale if **all** of:
- `mtime` older than `--stale-days` (default 180).
- Name is not self-documenting (`misc.md`, `notes2.txt`, `tmp-final-FINAL.pdf`, `untitled*`, `Copy of *`).
- Not referenced by any other file in the parent tree (quick `Grep` for the basename, recursive from the parent).

List stale files; do not auto-delete. The user decides.

## Procedure

1. **Pre-flight**
   - Confirm path exists and is a directory.
   - If the path is under a `.gitignore`d tree, warn and ask before continuing.
   - Read `<path>/.folder-audit.md` if it exists — this is the **prior state**.

2. **Inventory**
   - `Glob` the immediate children. Note count, total size, mtime distribution.
   - Categorize: regular files, subdirectories, dotfiles, symlinks.

3. **Detect signals** (above).

4. **Reflect against prior state**
   For each issue in prior state:
   - **Resolved** — issue is no longer present (cluster broken up, stale file gone, count under budget).
   - **Persisted** — still present. If prior state marks it `keep` (user chose to keep), skip silently.
   - **Worsened** — was a Watch, now Exceeded; or cluster grew by ≥ 50%.

   For new issues not in prior state: tag **New**.

5. **Report**
   Print a markdown report with sections:
   - **Summary** — counts, status (OK / Watch / Exceeded).
   - **Resolved since last audit** — bullets, if any.
   - **Worsened** — bullets with delta.
   - **New issues** — clusters, stale files, size flags.
   - **Proposed actions** — concrete moves (`mv A → subdir/A`). Number them so the user can say "apply 1, 3, skip 2".

6. **Apply (only if `--apply` was passed and user confirmed each action)**
   - Inside a git repo: `git mv` so history is preserved.
   - Outside a git repo: `mv`.
   - Never destructive — staleness flags result in proposals to move to `_attic/`, never `rm`.
   - After each move, update the new state file.

7. **Update state**
   Write `<path>/.folder-audit.md` with current findings. Mark anything the user explicitly chose to keep as `keep: true` so future audits don't re-flag it.

## State file format

```markdown
---
last_audited: 2026-05-16T14:32:00Z
budget: 25
stale_days: 180
file_count: 47
status: exceeded
---

## Issues

- id: cluster-meetings-2025
  type: similarity
  status: open    # open | resolved | keep
  detected: 2026-04-01
  description: 14 files named meeting-2025-MM-DD-*.md
  proposed: move to ./meetings/2025/

- id: stale-tmp-final
  type: staleness
  status: keep    # user said "leave it, I reference it from my todo app"
  detected: 2026-04-01
  description: tmp-final-FINAL.pdf, last touched 2024-08
  note: user keeps despite name; do not re-flag

## History

- 2026-04-01 — initial audit, 3 clusters found
- 2026-04-15 — cluster-screenshots resolved (moved to ./screenshots/)
- 2026-05-16 — file_count 47 → 52, worsening
```

The `keep` status is the **reflective** half: once the user decides "yes, that ugly filename stays", the skill remembers and shuts up.

## Scheduling

To make this self-healing across a set of folders, pair with `/loop` or `/schedule`:

```
/loop 7d /folder-audit ~/Documents/Obsidian/JBH/50-Sources
```

For multiple folders, prefer one `/schedule`d remote agent that walks a configured list, vs. many parallel loops.

## What this skill is NOT

- Not a deduplicator (no content-hash comparison; use `fdupes` for that).
- Not a renamer (only proposes moves into subfolders).
- Not a destructive cleanup (never deletes; staleness goes to `_attic/`).
- Not a code-organization tool — for code repos, naming conventions and module boundaries matter more than file count, and `kachkaev/fractal-tree-file-structure` is a better fit. This skill is for **data/notes/asset directories**.

## Defaults the user can tune

- Budget: 25 files. Raise for download-heavy or archive folders; lower for active workspaces.
- Stale window: 180 days. Lower for inbox-style folders; higher for archives.
- Max proposed subfolders per audit: 3. Hard cap — incremental healing beats big-bang reorg.
