import type { McpServerConfig } from './types.js';

/** OpenCode `mcp` entry shape (local stdio server). */
export type OpenCodeMcpLocal = {
  type: 'local';
  command: string[];
  environment?: Record<string, string>;
  enabled: true;
};

/** OpenCode `mcp` entry shape (remote HTTP server). */
export type OpenCodeMcpRemote = {
  type: 'remote';
  url: string;
  headers?: Record<string, string>;
  enabled: true;
};

export type OpenCodeMcpEntry = OpenCodeMcpLocal | OpenCodeMcpRemote;

/**
 * Map NanoClaw v2 MCP definitions (same shape as Claude Agent SDK) into
 * OpenCode config `mcp` field. Handles both stdio and remote (http/sse) servers.
 */
export function mcpServersToOpenCodeConfig(
  servers: Record<string, McpServerConfig> | undefined,
): Record<string, OpenCodeMcpEntry> {
  const out: Record<string, OpenCodeMcpEntry> = {};
  if (!servers) return out;
  for (const [name, cfg] of Object.entries(servers)) {
    if ('url' in cfg) {
      out[name] = {
        type: 'remote',
        url: cfg.url,
        ...(cfg.headers ? { headers: cfg.headers } : {}),
        enabled: true,
      };
    } else {
      out[name] = {
        type: 'local',
        command: [cfg.command, ...cfg.args],
        ...(Object.keys(cfg.env).length > 0 ? { environment: cfg.env } : {}),
        enabled: true,
      };
    }
  }
  return out;
}
