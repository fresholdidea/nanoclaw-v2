/**
 * One-time backfill: seed `container_configs` rows from existing
 * `groups/<folder>/container.json` files and `agent_groups.agent_provider`.
 *
 * Runs after migrations, before channel adapters start. Idempotent — skips
 * groups that already have a config row.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import type { McpServerConfig, AdditionalMountConfig } from './container-config.js';
import { getAllAgentGroups } from './db/agent-groups.js';
import {
  getContainerConfig,
  createContainerConfig,
  updateContainerConfigJson,
  updateContainerConfigScalars,
} from './db/container-configs.js';
import { log } from './log.js';
import type { ContainerConfigRow } from './types.js';

interface LegacyContainerJson {
  mcpServers?: Record<string, McpServerConfig>;
  packages?: { apt?: string[]; npm?: string[] };
  imageTag?: string;
  additionalMounts?: AdditionalMountConfig[];
  skills?: string[] | 'all';
  provider?: string;
  assistantName?: string;
  maxMessagesPerPrompt?: number;
}

/**
 * A row counts as "empty-default" when it carries no real container config —
 * no MCP servers, no packages, no mounts, no custom image. Such a row is
 * indistinguishable from "never configured" and is safe to re-seed from disk.
 * This is the shape left behind by the 2026-07 file→DB migration when a group
 * already had a bare row, which caused the original guard to skip its real
 * (file-only) config. See recovery script scripts/recover-migration-clobbered-configs.py.
 */
function isEmptyDefaultRow(row: ContainerConfigRow): boolean {
  const emptyJson = (s: string, empty: string) => !s || s === empty;
  return (
    emptyJson(row.mcp_servers, '{}') &&
    emptyJson(row.packages_apt, '[]') &&
    emptyJson(row.packages_npm, '[]') &&
    emptyJson(row.additional_mounts, '[]') &&
    !row.image_tag
  );
}

export function backfillContainerConfigs(): void {
  const groups = getAllAgentGroups();
  let backfilled = 0;
  let recovered = 0;

  for (const group of groups) {
    // A group with a non-empty config row is authoritative — leave it alone.
    // But an empty-default row (e.g. left by the file→DB migration) should NOT
    // shadow real config still living in the group's container.json: recover it.
    const existing = getContainerConfig(group.id);
    if (existing && !isEmptyDefaultRow(existing)) continue;

    // Read legacy container.json from disk
    const filePath = path.join(GROUPS_DIR, group.folder, 'container.json');
    let legacy: LegacyContainerJson = {};
    if (fs.existsSync(filePath)) {
      try {
        legacy = JSON.parse(fs.readFileSync(filePath, 'utf8')) as LegacyContainerJson;
      } catch (err) {
        log.warn('Backfill: failed to parse container.json, using defaults', {
          folder: group.folder,
          err: String(err),
        });
      }
    }

    // Empty-default row that already exists: re-seed its config columns from
    // disk in place (rather than creating a duplicate row). Only touch it when
    // the file actually has config to restore — never clobber a row down to the
    // same empty state, and never overwrite scalar identity fields already set.
    if (existing) {
      const hasFileConfig =
        (legacy.mcpServers && Object.keys(legacy.mcpServers).length > 0) ||
        (legacy.additionalMounts && legacy.additionalMounts.length > 0) ||
        (legacy.packages?.apt && legacy.packages.apt.length > 0) ||
        (legacy.packages?.npm && legacy.packages.npm.length > 0) ||
        !!legacy.imageTag;
      if (!hasFileConfig) continue;

      updateContainerConfigJson(group.id, 'mcp_servers', legacy.mcpServers ?? {});
      updateContainerConfigJson(group.id, 'additional_mounts', legacy.additionalMounts ?? []);
      updateContainerConfigJson(group.id, 'packages_apt', legacy.packages?.apt ?? []);
      updateContainerConfigJson(group.id, 'packages_npm', legacy.packages?.npm ?? []);
      if (legacy.imageTag) updateContainerConfigScalars(group.id, { image_tag: legacy.imageTag });
      recovered++;
      log.info('Backfill: recovered file-only config into empty DB row', { folder: group.folder });
      continue;
    }

    // DB agent_provider wins over file provider (matches old cascade)
    const provider = group.agent_provider || legacy.provider || null;

    const row: ContainerConfigRow = {
      agent_group_id: group.id,
      provider,
      model: null,
      effort: null,
      image_tag: legacy.imageTag ?? null,
      assistant_name: legacy.assistantName ?? null,
      max_messages_per_prompt: legacy.maxMessagesPerPrompt ?? null,
      skills: JSON.stringify(legacy.skills ?? 'all'),
      mcp_servers: JSON.stringify(legacy.mcpServers ?? {}),
      packages_apt: JSON.stringify(legacy.packages?.apt ?? []),
      packages_npm: JSON.stringify(legacy.packages?.npm ?? []),
      additional_mounts: JSON.stringify(legacy.additionalMounts ?? []),
      cli_scope: 'group',
      enable_agy_tooling: 0,
      enable_opencode_tooling: 0,
      provider_chain: null,
      updated_at: new Date().toISOString(),
    };

    createContainerConfig(row);
    backfilled++;
  }

  if (backfilled > 0 || recovered > 0) {
    log.info('Backfilled container_configs from disk', { created: backfilled, recovered });
  }
}
