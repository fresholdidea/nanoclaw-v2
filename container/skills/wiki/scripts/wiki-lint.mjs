#!/usr/bin/env node

/**
 * Deterministic, dependency-free structural lint for the Obsidian Wiki.
 *
 * The same file runs on the host checkout and inside the Wiki container:
 *   node wiki-lint.mjs --root /path/to/50-Wiki
 *
 * It deliberately separates structural errors from editorial warnings. The
 * log is historical prose and is excluded from the active link graph.
 */

import fs from 'node:fs';
import path from 'node:path';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const root = path.resolve(arg('--root', '/workspace/extra/obsidian/50-Wiki'));
const vault = path.resolve(arg('--vault', path.dirname(root)));
const errors = [];
const warnings = [];

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function relFrom(base, file) {
  return path.relative(base, file).split(path.sep).join('/');
}

function wikiRel(file) {
  return relFrom(root, file);
}

function vaultRel(file) {
  return relFrom(vault, file);
}

function noteKey(rel) {
  return rel.replace(/\.md$/i, '');
}

function readFrontmatter(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (!text.startsWith('---\n')) return { text, raw: '', keys: new Map(), sources: [] };
  const end = text.indexOf('\n---', 4);
  if (end < 0) return { text, raw: '', keys: new Map(), sources: [] };
  const raw = text.slice(4, end);
  const keys = new Map();
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (match) keys.set(match[1], match[2] ?? '');
  }
  const sources = [];
  let inSources = false;
  for (const line of lines) {
    if (/^sources:\s*/.test(line)) {
      inSources = true;
      const inline = line.replace(/^sources:\s*/, '').trim();
      if (inline && inline !== '[]') sources.push(inline.replace(/^['"]|['"]$/g, ''));
      continue;
    }
    if (inSources && /^\s*-\s+/.test(line)) {
      sources.push(line.replace(/^\s*-\s+/, '').trim().replace(/^['"]|['"]$/g, ''));
      continue;
    }
    if (inSources && line.trim() && !/^\s/.test(line)) inSources = false;
  }
  return { text, raw, keys, sources };
}

function resolveCandidates(target, fromFile) {
  const clean = target.trim().replace(/^<|>$/g, '').replace(/\.md$/i, '');
  if (!clean || clean.endsWith('/')) return [];
  const candidates = [];
  const add = (p) => {
    const normalized = path.normalize(p);
    if (!candidates.includes(normalized)) candidates.push(normalized);
  };
  if (clean.startsWith('/')) add(path.join(vault, clean));
  else {
    add(path.resolve(path.dirname(fromFile), clean));
    add(path.join(root, clean));
    add(path.join(vault, clean));
    if (clean.startsWith('50-Wiki/')) add(path.join(vault, clean));
  }
  return candidates
    .map((candidate) => (fs.existsSync(`${candidate}.md`) ? `${candidate}.md` : candidate))
    .filter((candidate) => fs.existsSync(candidate));
}

const wikiFiles = walk(root);
const activeFiles = wikiFiles.filter(
  (file) =>
    !['index.md', 'log.md', 'backlog.md'].includes(path.basename(file)) &&
    !path.basename(file).startsWith('_retired-'),
);
const allVaultFiles = walk(vault);
const vaultByKey = new Map();
const vaultByBase = new Map();
for (const file of allVaultFiles) {
  const key = vaultRel(file).replace(/\.md$/i, '');
  vaultByKey.set(key, file);
  const base = path.basename(file, '.md');
  if (!vaultByBase.has(base)) vaultByBase.set(base, []);
  vaultByBase.get(base).push(file);
}

const activeByKey = new Map(activeFiles.map((file) => [noteKey(wikiRel(file)), file]));
const indexFile = path.join(root, 'index.md');
const backlogFile = path.join(root, 'backlog.md');
const indexKeys = new Set();
const inbound = new Map();

function resolveWikiTarget(target, fromFile) {
  const clean = target.trim().replace(/^<|>$/g, '').replace(/\.md$/i, '');
  const direct = resolveCandidates(clean, fromFile).filter((file) => file.endsWith('.md'));
  if (direct.length) return { files: [...new Set(direct)], kind: 'direct' };
  const base = path.basename(clean);
  const byBase = vaultByBase.get(base) ?? [];
  if (byBase.length === 1) return { files: byBase, kind: 'basename' };
  if (byBase.length > 1) return { files: byBase, kind: 'ambiguous' };
  return { files: [], kind: 'missing' };
}

function linksIn(text) {
  return [...text.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)].map((m) => m[1].trim());
}

if (!fs.existsSync(root)) errors.push(`Wiki root does not exist: ${root}`);
if (!fs.existsSync(indexFile)) errors.push('Missing reserved file: index.md');
if (!fs.existsSync(path.join(root, 'log.md'))) errors.push('Missing reserved file: log.md');
if (!fs.existsSync(backlogFile)) errors.push('Missing maintenance file: backlog.md');

for (const file of activeFiles) {
  const fm = readFrontmatter(file);
  const rel = wikiRel(file);
  if (!fm.raw) errors.push(`${rel}: missing YAML frontmatter`);
  for (const key of ['type', 'updated', 'sources']) {
    if (!fm.keys.has(key)) errors.push(`${rel}: missing frontmatter field ${key}`);
  }
  if (fm.keys.get('updated') && !/^\d{4}-\d{2}-\d{2}$/.test(fm.keys.get('updated'))) {
    errors.push(`${rel}: updated must be YYYY-MM-DD`);
  }
  if (fm.keys.get('sources') === '[]' || fm.sources.length === 0) warnings.push(`${rel}: provenance is empty (sources: [])`);
  for (const source of fm.sources) {
    const sourceTarget = source.replace(/^\[\[|\]\]$/g, '');
    if (sourceTarget.startsWith('http')) continue;
    const resolved = resolveWikiTarget(sourceTarget, file);
    if (!resolved.files.length) warnings.push(`${rel}: source does not resolve: ${source}`);
  }
  for (const target of linksIn(fm.text)) {
    if (target.startsWith('http')) continue;
    const result = resolveWikiTarget(target, file);
    if (result.kind === 'missing') {
      errors.push(`${rel}: unresolved wikilink [[${target}]]`);
    } else if (result.kind === 'ambiguous') {
      warnings.push(`${rel}: ambiguous wikilink [[${target}]] (${result.files.map(vaultRel).join(', ')})`);
    }
    for (const destination of result.files) {
      const destinationKey = noteKey(vaultRel(destination));
      if (activeByKey.has(destinationKey)) inbound.set(destinationKey, (inbound.get(destinationKey) ?? 0) + 1);
    }
  }
}

if (fs.existsSync(indexFile)) {
  for (const target of linksIn(fs.readFileSync(indexFile, 'utf8'))) {
    const result = resolveWikiTarget(target, indexFile);
    if (result.kind === 'direct' || result.kind === 'basename') {
      for (const destination of result.files) {
        const key = noteKey(vaultRel(destination));
        if (key.startsWith('50-Wiki/')) indexKeys.add(key.replace(/^50-Wiki\//, ''));
      }
    }
  }
  for (const file of activeFiles) {
    const key = wikiRel(file).replace(/\.md$/i, '');
    if (!indexKeys.has(key)) errors.push(`index.md does not index ${key}`);
  }
  const indexFm = readFrontmatter(indexFile);
  const dates = activeFiles.map((file) => readFrontmatter(file).keys.get('updated')).filter(Boolean).sort();
  if (dates.length && indexFm.keys.get('updated') && indexFm.keys.get('updated') < dates.at(-1)) {
    warnings.push(`index.md updated ${indexFm.keys.get('updated')} is older than latest page ${dates.at(-1)}`);
  }
}

for (const file of activeFiles) {
  const key = wikiRel(file).replace(/\.md$/i, '');
  if (!inbound.has(key) && !key.startsWith('knowledge/_retired-')) warnings.push(`orphan Wiki page: ${key}`);
}

const entityDirs = new Set(['clients', 'people']);
for (const file of activeFiles) {
  const [dir] = wikiRel(file).split('/');
  if (!entityDirs.has(dir)) continue;
  const base = path.basename(file, '.md');
  const canonical = readFrontmatter(file).keys.get('canonical');
  const candidates = (vaultByBase.get(base) ?? []).filter((other) => !other.startsWith(root + path.sep));
  if (candidates.length && !canonical) warnings.push(`${wikiRel(file)}: add canonical frontmatter (${candidates.map(vaultRel).join(', ')})`);
}

if (fs.existsSync(backlogFile)) {
  const backlog = readFrontmatter(backlogFile);
  for (const key of ['type', 'updated', 'sources']) {
    if (!backlog.keys.has(key)) errors.push(`backlog.md: missing frontmatter field ${key}`);
  }
  if (linksIn(backlog.text).length) warnings.push('backlog.md contains wikilinks; keep candidates as plain text until pages exist');
}

if (fs.existsSync(path.join(root, 'log.md'))) {
  const dates = [...fs.readFileSync(path.join(root, 'log.md'), 'utf8').matchAll(/^## \[(\d{4}-\d{2}-\d{2})\]/gm)].map((m) => m[1]);
  const descending = dates.every((date, i) => i === 0 || date <= dates[i - 1]);
  const ascending = dates.every((date, i) => i === 0 || date >= dates[i - 1]);
  if (!descending && !ascending) warnings.push('log.md has mixed chronological ordering; preserve history and use one ordering for new entries');
}

console.log(`Wiki lint: ${activeFiles.length} active pages`);
if (errors.length) {
  console.log(`Errors (${errors.length}):`);
  for (const item of errors) console.log(`  ERROR ${item}`);
}
if (warnings.length) {
  console.log(`Warnings (${warnings.length}):`);
  for (const item of warnings) console.log(`  WARN  ${item}`);
}
if (!errors.length && !warnings.length) console.log('OK: no structural findings');
process.exitCode = errors.length ? 1 : 0;
