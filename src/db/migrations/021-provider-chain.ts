import type { DbDriver } from '../driver.js';
import type { Migration } from './index.js';

export const migration021: Migration = {
  version: 21,
  name: 'provider-chain',
  async up(db: DbDriver) {
    await db.run('ALTER TABLE container_configs ADD COLUMN provider_chain TEXT');
  },
};
