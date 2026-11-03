/**
 * Structural guard: container/entrypoint.sh must NOT run `mnemon setup`.
 *
 * On this install MNEMON_DATA_DIR is /workspace/extra/mnemon, the mount of the
 * shared host store ~/.mnemon. `mnemon setup` writes prompt/{guide,skill}.md
 * and data/default/mnemon.db under MNEMON_DATA_DIR, i.e. into the store that
 * host hooks read by path, and installs Claude Code hooks that duplicate the
 * curated container skill (container/skills/mnemon/SKILL.md). Live spawns
 * bypass the entrypoint (`bash -c 'exec bun …'` in src/container-runner.ts),
 * so the line only ever ran on a bare `docker run` of the image.
 *
 * The stock /add-mnemon skill adds this line in Phase 2 step 2; this install
 * skips that step. Re-add it and this test goes red. Comment lines are ignored
 * so the entrypoint may still explain the absence.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'vitest';

function entrypointCommands(): string {
  // From src/ up to repo root, then into container/.
  const p = path.resolve(__dirname, '..', 'container', 'entrypoint.sh');
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

describe('container/entrypoint.sh does not run mnemon setup', () => {
  const text = entrypointCommands();

  it('never invokes mnemon setup, through the shim or the real binary', () => {
    expect(text).not.toMatch(/mnemon(?:-real)?\s+setup/);
  });
});
