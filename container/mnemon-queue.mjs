// Queue a mnemon write for host-side replay (see mnemon-shim.sh).
// Usage: bun mnemon-queue.mjs <queue-dir> <verb> [args...]
// Writes {ts, argv} as JSON to a uniquely named file. Written to a .tmp path
// first, then renamed — rename within one directory is atomic on the mount,
// so the host drainer never sees a half-written file.
import fs from 'fs';
import path from 'path';

const [queueDir, ...argv] = process.argv.slice(2);
if (!queueDir || argv.length === 0) {
  console.error('usage: mnemon-queue.mjs <queue-dir> <verb> [args...]');
  process.exit(2);
}

// A queued write is acknowledged to the agent immediately but only executed
// later by the host. Reject malformed `remember` flags here so an agent gets a
// real error rather than a misleading success followed by a silent .err file.
const REMEMBER_VALUE_FLAGS = new Set([
  '--cat', '--entities', '--entity-mode', '--imp', '--source', '--tags',
]);
const REMEMBER_BOOLEAN_FLAGS = new Set(['--no-diff']);
const VALID_CATEGORIES = new Set([
  'preference', 'decision', 'fact', 'insight', 'context', 'general',
]);

function reject(message) {
  console.error(`mnemon queue: ${message}`);
  process.exit(2);
}

function validateRemember(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('-')) continue;
    if (REMEMBER_BOOLEAN_FLAGS.has(arg)) continue;
    if (!REMEMBER_VALUE_FLAGS.has(arg)) reject(`unsupported flag: ${arg}`);
    if (index + 1 >= args.length) reject(`missing value for ${arg}`);
    const value = args[index + 1];
    if (arg === '--cat' && !VALID_CATEGORIES.has(value)) {
      reject(`invalid category "${value}"; valid: ${[...VALID_CATEGORIES].join(', ')}`);
    }
    index += 1;
  }
}

if (argv[0] === 'remember') validateRemember(argv.slice(1));

const name = `${Date.now()}-${process.pid}-${Math.floor(Math.random() * 1e6)}.json`;
const tmp = path.join(queueDir, `.${name}.tmp`);
const final = path.join(queueDir, name);
fs.writeFileSync(tmp, JSON.stringify({ ts: new Date().toISOString(), argv }) + '\n');
fs.renameSync(tmp, final);
console.log(`queued for host import: ${argv[0]} (${name})`);
