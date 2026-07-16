import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Guards the barrel (`index.ts`) against the failure mode where a tool module
 * exists and calls `registerTools([...])` at import time, but nothing imports
 * it — so the side-effect registration never runs and the tool silently never
 * reaches any agent. Per-module tests import the module directly and therefore
 * cannot catch a missing barrel import; this one reads the barrel source.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const barrel = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf-8');

describe('mcp-tools barrel', () => {
  for (const mod of ['core', 'interactive', 'agents', 'self-mod', 'query-agy', 'query-opencode']) {
    it(`imports ./${mod}.js for its registerTools side effect`, () => {
      expect(barrel).toContain(`import './${mod}.js';`);
    });
  }
});
