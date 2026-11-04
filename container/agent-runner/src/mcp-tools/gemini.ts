/**
 * ask_gemini: hand a big read to Gemini through the host's broker.
 *
 * Fire-and-forget, like the self-mod tools: the tool writes a
 * `gemini_request` system row and returns at once. The host copies the named
 * files (only ones this container can already read), runs Gemini under the
 * operator's Google sign-in, and sends the answer back as a separate message
 * with the full text attached. A Gemini run takes minutes, longer than any
 * MCP tool-call timeout, which is why the answer cannot come back inline.
 *
 * Checks here answer the agent instantly; the host re-validates everything
 * (mounts, symlinks, credential paths, size and daily caps).
 */
import fs from 'fs';

import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const MAX_PROMPT_CHARS = 12_000;
const MAX_FILES = 20;
const ALLOWED_ROOTS = ['/workspace/agent/', '/workspace/inbox/', '/workspace/extra/'];
const EFFORTS = ['low', 'medium', 'high'];

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function checkFile(p: string): string | null {
  if (!ALLOWED_ROOTS.some((root) => p.startsWith(root))) {
    return `${p} must be under /workspace/agent, /workspace/inbox or /workspace/extra`;
  }
  if (p.split('/').some((s, i) => i > 0 && (s === '' || s === '.' || s === '..'))) {
    return `${p} must be an absolute, normalized path`;
  }
  const st = fs.lstatSync(p, { throwIfNoEntry: false });
  if (!st) return `${p} does not exist`;
  if (st.isSymbolicLink()) return `${p} is a symlink; pass the real path`;
  if (!st.isFile()) return `${p} is not a regular file`;
  return null;
}

export const askGemini: McpToolDefinition = {
  tool: {
    name: 'ask_gemini',
    description:
      'Ask Gemini (Google, run by the host) to read files and answer a question about them. Use it for reads too big or too many for your own context: long meeting transcripts, several documents at once, large exports or logs. With no files, it answers a research question using Google Search. ' +
      'Asynchronous: returns a request id at once, and the answer arrives later (usually 1-5 minutes) as a separate message from gemini-broker with the full text attached as a .md file. Do not wait or poll; finish what you can, or end your turn. In a scheduled task the answer arrives in a later turn that is not a task run, so the final text of that turn is neither logged nor delivered: finish the work there with tools (write the file, send the message). ' +
      'Pass absolute paths you can already read under /workspace/agent, /workspace/inbox or /workspace/extra (max 20 files, about 3 MB in total). Gemini sees only those copies and your prompt, so make the prompt self-contained. Symlinks and credential files are refused, and daily caps apply. ' +
      "Treat the answer as Gemini's reading of the files: verify claims that matter against the source before acting on them or passing them on.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        prompt: {
          type: 'string',
          description:
            'The question or task, self-contained: what to look for, what to compare, and the output shape you want.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute paths of the files to read.',
        },
        effort: {
          type: 'string',
          enum: EFFORTS,
          description: 'Reasoning effort (default high). Use low for simple extraction.',
        },
        label: { type: 'string', description: 'Short label to recognize the answer by (optional).' },
      },
      required: ['prompt'],
    },
  },
  async handler(args) {
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (!prompt) return err('prompt is required');
    if (prompt.length > MAX_PROMPT_CHARS) return err(`prompt must be at most ${MAX_PROMPT_CHARS} characters`);

    const files = args.files ?? [];
    if (!Array.isArray(files) || !files.every((f) => typeof f === 'string')) {
      return err('files must be an array of absolute paths');
    }
    const unique = [...new Set(files as string[])];
    if (unique.length > MAX_FILES) return err(`at most ${MAX_FILES} files per request`);
    for (const f of unique) {
      const problem = checkFile(f);
      if (problem) return err(problem);
    }

    const effort = args.effort ?? 'high';
    if (typeof effort !== 'string' || !EFFORTS.includes(effort)) return err('effort must be low, medium or high');
    const label = typeof args.label === 'string' ? args.label.slice(0, 80) : '';

    const requestId = `gem-req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    await writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'gemini_request', requestId, prompt, files: unique, effort, label }),
    });
    const what =
      unique.length === 0 ? 'no files (web research)' : unique.length === 1 ? '1 file' : `${unique.length} files`;
    return ok(
      `Gemini request ${requestId} queued with ${what}. The answer arrives later as a separate message from gemini-broker, with the full text attached. Do not wait or poll: finish what you can now, or end your turn. If the host refuses the request, that message says why.`,
    );
  },
};

registerTools([askGemini]);
