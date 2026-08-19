#!/usr/bin/env node
// JAYA documentation link validator.
//
// Validates every relative file link and every Markdown anchor in the /docs
// Markdown set. External links (http, https, mailto) are out of scope and are
// reported as skipped rather than silently ignored.
//
// Usage:   node docs/tools/validate-doc-links.mjs
// Exit:    0 = all internal links and anchors resolve
//          1 = at least one broken link or anchor
//
// Owned by: DOC-001 planning baseline. Documentation tooling only — this is not
// application code and is not part of any module.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['tools']);

/** Recursively collect Markdown files under /docs, excluding tooling directories. */
function collectMarkdown(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) collectMarkdown(full, acc);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * GitHub heading-slug algorithm: lowercase, strip backticks and other Markdown
 * emphasis, drop every character that is not a letter, number, space or hyphen,
 * then replace spaces with hyphens. Repeated slugs get a numeric suffix.
 */
function slugify(heading, seen) {
  const base = heading
    .replace(/`/g, '')
    .replace(/\*\*|__|\*|_/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links render as their text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N} \-]/gu, '')
    .replace(/ /g, '-');
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n === 0 ? base : `${base}-${n}`;
}

/** Extract heading anchors from a Markdown file, ignoring fenced code blocks. */
function anchorsOf(file) {
  const anchors = new Set();
  const seen = new Map();
  let inFence = false;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) anchors.add(slugify(m[2], seen));
  }
  return anchors;
}

const files = collectMarkdown(DOCS_DIR);
if (files.length === 0) {
  console.error('No Markdown files found under /docs.');
  process.exit(1);
}

const anchorIndex = new Map(files.map(f => [path.resolve(f), anchorsOf(f)]));

const rel = f => path.relative(DOCS_DIR, f).split(path.sep).join('/');
const broken = [];
const perFile = [];
let internal = 0, external = 0;

for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  let inFence = false, fileLinks = 0;

  lines.forEach((line, idx) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;

    for (const m of line.matchAll(/(?<!!)\[(?:[^\]]*)\]\(\s*([^)\s]+?)\s*\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:|tel:)/i.test(target)) { external++; continue; }
      internal++; fileLinks++;

      const hashAt = target.indexOf('#');
      const filePart = hashAt === -1 ? target : target.slice(0, hashAt);
      const anchor = hashAt === -1 ? '' : decodeURIComponent(target.slice(hashAt + 1));
      const where = `${rel(file)}:${idx + 1}`;

      let resolved = path.resolve(file);
      if (filePart) {
        resolved = path.resolve(path.dirname(file), filePart);
        if (!fs.existsSync(resolved)) {
          broken.push(`${where}  MISSING FILE    ${target}`);
          continue;
        }
      }
      if (anchor) {
        if (!anchorIndex.has(resolved)) {
          // Anchor into a file outside the scanned set: index it on demand.
          if (resolved.endsWith('.md')) anchorIndex.set(resolved, anchorsOf(resolved));
          else { broken.push(`${where}  ANCHOR ON NON-MARKDOWN TARGET  ${target}`); continue; }
        }
        if (!anchorIndex.get(resolved).has(anchor)) {
          broken.push(`${where}  MISSING ANCHOR  ${target}`);
        }
      }
    }
  });

  perFile.push({ file: rel(file), links: fileLinks, anchors: anchorIndex.get(path.resolve(file)).size });
}

console.log('JAYA documentation link validation');
console.log('==================================');
console.log(`docs root      : ${rel(DOCS_DIR) || '.'}  (${DOCS_DIR})`);
console.log(`files scanned  : ${files.length}`);
for (const r of perFile) {
  console.log(`  ${r.file.padEnd(38)} internal links: ${String(r.links).padStart(3)}   headings/anchors: ${String(r.anchors).padStart(3)}`);
}
console.log(`internal links : ${internal}`);
console.log(`external links : ${external} (skipped — out of scope)`);
console.log(`broken         : ${broken.length}`);
if (broken.length) {
  console.log('');
  for (const b of broken) console.log(`  ${b}`);
  console.log('');
  console.log('RESULT: FAIL');
  process.exit(1);
}
console.log('');
console.log('RESULT: PASS — every relative file link and Markdown anchor resolves');
process.exit(0);
