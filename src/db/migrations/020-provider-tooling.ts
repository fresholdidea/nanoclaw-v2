import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration020: Migration = {
  version: 20,
  name: 'provider-tooling',
  up(db: Database.Database) {
    db.prepare('ALTER TABLE container_configs ADD COLUMN enable_agy_tooling INTEGER NOT NULL DEFAULT 0').run();
    db.prepare('ALTER TABLE container_configs ADD COLUMN enable_opencode_tooling INTEGER NOT NULL DEFAULT 0').run();
  },
};
