import fs from 'node:fs';

const agyPath = 'container/agent-runner/src/providers/agy.ts';
let agy = fs.readFileSync(agyPath, 'utf8');
if (!agy.includes('MemorySessionHookRegistration')) {
  const marker = "import { registerProvider } from './provider-registry.js';";
  if (!agy.includes(marker)) throw new Error(`Agy provider missing registry import: ${agyPath}`);
  agy = agy.replace(
    marker,
    `${marker}\nimport type { MemorySessionHookRegistration } from '../memory/session-hook.js';`,
  );
}
if (!agy.includes('registerMemorySessionHook(')) {
  const marker = '  isSessionInvalid(err: unknown): boolean {';
  if (!agy.includes(marker)) throw new Error(`Agy provider missing session-invalid seam: ${agyPath}`);
  agy = agy.replace(
    marker,
    `  // agy has no native session-start hook; memory is supplied through the container instructions.\n  registerMemorySessionHook(_hook: MemorySessionHookRegistration): void {}\n\n${marker}`,
  );
}
fs.writeFileSync(agyPath, agy);

const mcpPath = 'container/agent-runner/src/providers/mcp-to-agy.ts';
let mcp = fs.readFileSync(mcpPath, 'utf8');
mcp = mcp.replace('args: cfg.args,', 'args: cfg.args ?? [],');
mcp = mcp.replace('Object.keys(cfg.env).length', 'Object.keys(cfg.env ?? {}).length');
fs.writeFileSync(mcpPath, mcp);
