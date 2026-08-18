#!/usr/bin/env node

/**
 * One-time/repeatable Wiki hygiene migration.
 *
 * This is intentionally conservative: it only edits the Wiki tree, never
 * raw sources or the rest of the vault. Re-running it is idempotent.
 */

import fs from 'node:fs';
import path from 'node:path';

function cliArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const root = path.resolve(cliArg('--root', '/workspace/extra/obsidian/50-Wiki'));
const vault = path.resolve(cliArg('--vault', path.dirname(root)));
const date = cliArg('--date', new Date().toISOString().slice(0, 10));

const candidates = [
  'ab-testing-lead-gen-vs-traffic',
  'abm-signal-scoring',
  'audience-self-selection-ux',
  'brand-voice-guide',
  'clay-prospecting-workflow',
  'competitor-keyword-gap-analysis',
  'content-bucket-framework',
  'conversion-lag-analysis',
  'daily-budget-vs-cbo',
  'distributor-marketing-model',
  'eeat-seo-strategy',
  'hubspot-pardot-migration',
  'ipeds-enrichment',
  'job-title-mapping',
  'linkedin-personal-brand-launch',
  'merchant-center-custom-labels',
  'negative-keyword-taxonomy',
  'opinion-driven-content',
  'peak-season-campaign-launch',
  'pipeline-consolidation',
  'sdr-content-alignment',
  'seasonal-budget-frontloading',
  'self-contained-dashboard-reporting',
  'thought-leadership-video-workflow',
];
const candidateSet = new Set(candidates);

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

function rel(base, file) {
  return path.relative(base, file).split(path.sep).join('/');
}

function frontmatterBounds(text) {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---', 4);
  return end < 0 ? null : { end, raw: text.slice(4, end) };
}

function hasKey(raw, key) {
  return raw.split(/\r?\n/).some((line) => new RegExp(`^${key}:\\s*`).test(line));
}

const files = walk(root).filter((file) => !['index.md', 'log.md', 'backlog.md'].includes(path.basename(file)));
const changed = [];
const occurrences = new Map();

for (const file of files) {
  const original = fs.readFileSync(file, 'utf8');
  let text = original;
  const fileRel = rel(root, file);

  text = text.replace(/\[\[knowledge\/([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (whole, target, label) => {
    if (!candidateSet.has(target)) return whole;
    if (!occurrences.has(target)) occurrences.set(target, new Set());
    occurrences.get(target).add(fileRel);
    return label ? `${label} (backlog candidate: ${target})` : `${target} (backlog candidate)`;
  });

  // A single source summary had a directory link where the specific archive
  // source was intended. Keep the link, but point it at the real source file.
  text = text.replaceAll('[[50-Sources/]]', '[[50-Sources/superhuman-ai-newsletter-archive]]');

  const bounds = frontmatterBounds(text);
  if (bounds && !hasKey(bounds.raw, 'sources')) {
    const insertAt = text.indexOf('\n---', 4);
    text = `${text.slice(0, insertAt)}\nsources: []${text.slice(insertAt)}`;
  }

  if (text !== original) {
    fs.writeFileSync(file, text);
    changed.push(fileRel);
  }
}

function chooseCanonical(file) {
  const base = path.basename(file, '.md');
  const candidatesOutside = walk(vault)
    .filter((other) => other !== file && !other.startsWith(`${root}${path.sep}`) && path.basename(other, '.md') === base)
    .filter((other) => /(?:^|\/)90-System\/(?:Companies|People)\//.test(rel(vault, other)));
  candidatesOutside.sort((a, b) => {
    const aRel = rel(vault, a);
    const bRel = rel(vault, b);
    const aPeople = aRel.includes('/People/');
    const bPeople = bRel.includes('/People/');
    if (aPeople !== bPeople) return aPeople ? -1 : 1;
    return aRel.length - bRel.length || aRel.localeCompare(bRel);
  });
  return candidatesOutside[0];
}

for (const file of files) {
  const fileRel = rel(root, file);
  const top = fileRel.split('/')[0];
  if (!['clients', 'people'].includes(top)) continue;
  let text = fs.readFileSync(file, 'utf8');
  const bounds = frontmatterBounds(text);
  if (!bounds || hasKey(bounds.raw, 'canonical')) continue;
  const canonical = chooseCanonical(file);
  if (!canonical) continue;
  const insertAt = text.indexOf('\n---', 4);
  const canonicalPath = rel(vault, canonical).replace(/\.md$/i, '');
  text = `${text.slice(0, insertAt)}\ncanonical: "[[${canonicalPath}]]"${text.slice(insertAt)}`;
  fs.writeFileSync(file, text);
  if (!changed.includes(fileRel)) changed.push(fileRel);
}

const backlogFile = path.join(root, 'backlog.md');
if (!fs.existsSync(backlogFile)) {
  const lines = [
    '---',
    'type: wiki-backlog',
    `updated: ${date}`,
    'sources: []',
    '---',
    '',
    '# Wiki Backlog',
    '',
    'These are methodology candidates referenced by existing Wiki deliverables but not yet supported by a standalone source or page. They remain plain text in active pages until a source is ingested; do not create placeholder pages just to satisfy a link check.',
    '',
    '## Unwritten methodology candidates',
    '',
  ];
  for (const target of candidates) {
    const refs = [...(occurrences.get(target) ?? [])].sort();
    lines.push(`- ${target}${refs.length ? ` — referenced by ${refs.join(', ')}` : ''}`);
  }
  lines.push('', '## Promotion rule', '', 'Promote a candidate to a Wiki page only after a raw source is saved in `50-Sources/`, the page has explicit provenance, and `index.md` is updated.', '');
  fs.writeFileSync(backlogFile, lines.join('\n'));
  changed.push('backlog.md');
}

const indexFile = path.join(root, 'index.md');
if (fs.existsSync(indexFile)) {
  let index = fs.readFileSync(indexFile, 'utf8');
  const end = index.indexOf('\n---', 4);
  if (end >= 0) index = `${index.slice(0, end).replace(/^updated:\s*.*$/m, `updated: ${date}`)}${index.slice(end)}`;
  if (!index.includes('[[backlog]]')) {
    index = `${index.trimEnd()}\n\n## Maintenance\n\n- [[backlog]] — Unwritten methodology candidates and promotion rules.\n`;
  }
  fs.writeFileSync(indexFile, index);
  changed.push('index.md');
}

const logFile = path.join(root, 'log.md');
if (fs.existsSync(logFile)) {
  const logEntry = `\n\n## [${date}] update | Wiki hygiene boundaries and backlog normalization\n\nMoved the Wiki role into provider-neutral NanoClaw instructions; preserved the legacy local instructions in migration staging. Added deterministic structural lint, converted the known unwritten methodology references to plain-text backlog candidates, made missing provenance explicit with \\`sources: []\\`, repaired one directory-level source link, and marked duplicate client/person briefs with canonical records.\n`;
  const log = fs.readFileSync(logFile, 'utf8');
  if (!log.includes('Wiki hygiene boundaries and backlog normalization')) fs.writeFileSync(logFile, `${log.trimEnd()}${logEntry}`);
}

console.log(`Wiki maintenance changed ${changed.length} file(s):`);
for (const file of [...new Set(changed)].sort()) console.log(`  ${file}`);
