import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
it('the add-dashboard payload preserves the installed HUD and pusher exactly', () => {
  const root = process.cwd(),
    resources = path.join(root, '.claude/skills/add-dashboard/resources');
  expect(fs.readFileSync(path.join(resources, 'dashboard-pusher.ts'), 'utf8')).toBe(
    fs.readFileSync(path.join(root, 'src/dashboard-pusher.ts'), 'utf8'),
  );
  const walk = (dir: string): string[] =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  for (const file of walk(path.join(root, 'src/hud'))) {
    const relative = path.relative(path.join(root, 'src/hud'), file);
    expect(fs.readFileSync(path.join(resources, 'hud', relative), 'utf8'), relative).toBe(
      fs.readFileSync(file, 'utf8'),
    );
  }
});
