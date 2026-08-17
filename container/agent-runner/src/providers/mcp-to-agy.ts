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
      // args/env are optional on the stdio config — default them here rather
      // than pushing undefined into agy's required fields.
      out[name] = {
        command: cfg.command,
        args: cfg.args ?? [],
        ...(cfg.env && Object.keys(cfg.env).length > 0 ? { env: cfg.env } : {}),
      };
    }
  }
  return out;
}
