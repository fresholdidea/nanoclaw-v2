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

const name = `${Date.now()}-${process.pid}-${Math.floor(Math.random() * 1e6)}.json`;
const tmp = path.join(queueDir, `.${name}.tmp`);
const final = path.join(queueDir, name);
fs.writeFileSync(tmp, JSON.stringify({ ts: new Date().toISOString(), argv }) + '\n');
fs.renameSync(tmp, final);
console.log(`queued for host import: ${argv[0]} (${name})`);
