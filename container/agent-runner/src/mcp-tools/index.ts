/**
 * MCP tools barrel — imports each tool module for its side-effect
 * `registerTools([...])` call, then starts the MCP server.
 *
 * Adding a new tool module: create the file, call `registerTools([...])`
 * at module scope, and append the import here. No central list.
 */
import './core.js';
import './interactive.js';
import './agents.js';
import './self-mod.js';
// Provider-delegation tools. Registered unconditionally: each handler
// self-describes the "not enabled" case (missing binary → clean error),
// so a group without agy/opencode tooling sees a tool that explains how to
// enable it rather than a silently-absent one.
import './query-agy.js';
import './query-opencode.js';
import { startMcpServer } from './server.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

startMcpServer().catch((err) => {
  log(`MCP server error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
