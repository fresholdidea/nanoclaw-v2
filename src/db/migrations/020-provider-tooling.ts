import type { DbDriver } from '../driver.js';
import type { Migration } from './index.js';

export const migration020: Migration = {
  version: 20,
  name: 'provider-tooling',
  async up(db: DbDriver) {
    await db.run('ALTER TABLE container_configs ADD COLUMN enable_agy_tooling INTEGER NOT NULL DEFAULT 0');
    await db.run('ALTER TABLE container_configs ADD COLUMN enable_opencode_tooling INTEGER NOT NULL DEFAULT 0');
  },
};
