/**
 * The status documents must describe the repository that exists (FND-004c, documentation accuracy).
 *
 * `CURRENT_IMPLEMENTATION_STATUS.md` and `MASTER_IMPLEMENTATION_CHECKLIST.md` are authority ranks 2
 * and 3. Everything downstream — what is built, what is next, what may be called complete — is read
 * from them, and prose rots silently: a component lands, the row that called it `NOT STARTED` stays,
 * and the next reader either builds it twice or works around a dependency that is already there.
 * `tests/kernel-overview.test.ts` catches that for `kernel/README.md`; this file catches it for the
 * two documents that actually govern.
 *
 * Every expectation here is **derived** — from the filesystem, from the architecture manifest, or
 * from the checklist's own rows — rather than written down. A hardcoded count is a second thing to
 * keep in step, and it would go stale the same way the prose does. The tests are deliberately
 * one-sided: they fail on under-reporting (a delivered component still marked absent, a stale
 * count, a next-task selection that has already been delivered) and on over-claiming (a component
 * called complete, or a live-database claim this repository cannot make). They say nothing about
 * wording otherwise, because a documentation test that pins prose is one that gets deleted.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { KERNEL_COMPONENTS } from '../platform/architecture/manifest.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KERNEL_DIR = path.join(REPO_ROOT, 'kernel');
const DOCS_DIR = path.join(REPO_ROOT, 'docs');

const STATUS = readFileSync(path.join(DOCS_DIR, 'CURRENT_IMPLEMENTATION_STATUS.md'), 'utf8');
const CHECKLIST = readFileSync(path.join(DOCS_DIR, 'MASTER_IMPLEMENTATION_CHECKLIST.md'), 'utf8');

/**
 * Components with a `CONTRACT.md`, which is this repository's marker for "the contract is fixed and
 * the implementation exists". The same rule `tests/kernel-overview.test.ts` derives from.
 */
const implemented = KERNEL_COMPONENTS.filter((component) =>
  existsSync(path.join(KERNEL_DIR, component.dir, 'CONTRACT.md')),
);

/** A row of a Markdown table, as trimmed cells. */
const cellsOf = (line: string): string[] =>
  line
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());

/** The §B row for a kernel component: `| K-02 | Authentication … | contract | implementation | … |` */
function kernelRow(id: string): string[] {
  const line = CHECKLIST.split(/\r?\n/).find(
    (candidate) => /^\|/.test(candidate) && cellsOf(candidate)[0] === id,
  );
  assert.ok(line !== undefined, `MASTER_IMPLEMENTATION_CHECKLIST.md has no row for ${id}`);
  return cellsOf(line);
}

// ---------------------------------------------------------------------------
// Delivered components are reported as delivered
// ---------------------------------------------------------------------------

test('the fixture for these tests is the real kernel, and it holds K-01, K-02 and K-03', () => {
  const ids = implemented.map((component) => component.id);
  for (const required of ['K-01', 'K-02', 'K-03']) {
    assert.ok(ids.includes(required), `${required} has a CONTRACT.md; the marker convention moved`);
  }
});

test('every implemented component has a COMPLETE contract row and a started implementation', () => {
  for (const component of implemented) {
    const cells = kernelRow(component.id);
    const contract = cells[2] ?? '';
    const implementation = cells[3] ?? '';

    assert.ok(
      contract.startsWith('`[x]`'),
      `${component.id} has a CONTRACT.md on disk but its checklist contract cell says ${contract.slice(0, 24)}`,
    );
    assert.ok(
      contract.includes(`kernel/${component.dir}/CONTRACT.md`),
      `${component.id}'s checklist row does not link its contract, so a reader cannot reach it`,
    );
    assert.ok(
      implementation.startsWith('`[~]`'),
      `${component.id} is implemented but its checklist row says ` +
        `${implementation.slice(0, 24)} — a delivered component reported as unbuilt is how ` +
        'it gets built twice',
    );
    assert.ok(
      !/`\[x\]`/.test(implementation),
      `${component.id}'s implementation is marked COMPLETE; no kernel component is complete`,
    );
  }
});

/** One section of the status document, by heading, so a table is read where it actually lives. */
function statusSection(heading: string): string {
  const start = STATUS.indexOf(`### ${heading}`);
  assert.ok(start !== -1, `CURRENT_IMPLEMENTATION_STATUS.md has no "${heading}" section`);
  const next = STATUS.indexOf('\n### ', start + 1);
  return STATUS.slice(start, next === -1 ? undefined : next);
}

test('CURRENT_IMPLEMENTATION_STATUS.md reports every implemented component as a foundation', () => {
  // §4.3 is the table a reader consults for "does this capability exist yet". A delivered component
  // still listed as Absent there is the single most misleading line in the document. Scoped to that
  // table: §4.2 lists infrastructure — a broker, a search index — that K-08 and K-15 do not provide
  // and that really is absent.
  const capability = statusSection('4.3 Platform capability');
  for (const component of implemented) {
    const line = capability
      .split(/\r?\n/)
      .find((candidate) => /^\|/.test(candidate) && cellsOf(candidate).at(-1) === component.id);
    assert.ok(line !== undefined, `§4.3 has no row for ${component.id}`);
    assert.ok(
      !/\|\s*Absent\b/.test(line),
      `§4.3 still calls ${component.id} Absent, but kernel/${component.dir}/CONTRACT.md exists`,
    );
    assert.match(
      line,
      /Foundation only/,
      `§4.3 must call ${component.id} a foundation — not complete, and not absent`,
    );
  }
});

test('the derived component counts in both documents match the filesystem', () => {
  const count = implemented.length;
  assert.match(
    STATUS,
    new RegExp(`Modules implemented \\| ${count} of 62`),
    `§1 must report ${count} implemented components, which is what is on disk`,
  );
  assert.match(
    STATUS,
    new RegExp(`Module contracts written \\| ${count} of 62`),
    `§1 must report ${count} module contracts, which is what is on disk`,
  );
  for (const component of implemented) {
    assert.ok(
      STATUS.includes(`kernel/${component.dir}/CONTRACT.md`),
      `§1 does not link ${component.id}'s contract`,
    );
  }
});

// ---------------------------------------------------------------------------
// K-02 in particular: delivered, and honestly incomplete
// ---------------------------------------------------------------------------

test('neither document claims authentication is absent, unbuilt or the next task', () => {
  const denials: ReadonlyArray<{ readonly pattern: RegExp; readonly why: string }> = [
    { pattern: /\|\s*Authentication\s*\|\s*Absent\s*\|/i, why: 'lists Authentication as absent' },
    {
      pattern: /\bK-02\b[^.|]{0,60}\b(does not exist|is absent|is not built|is unbuilt)\b/i,
      why: 'states K-02 does not exist',
    },
    {
      pattern: /\bK-02\b[^.|]{0,40}\bis not\s+(built|delivered|implemented|started|present)\b/i,
      why: 'states K-02 is not built',
    },
    {
      pattern: /next genuinely unblocked task:\s*\*{0,2}FND-004c/i,
      why: 'still selects FND-004c as the next task, which has been delivered',
    },
    {
      pattern: /\|\s*P0-33\s*\|[^|]*\|\s*`\[ \]`/,
      why: 'still marks P0-33 Authentication NOT STARTED',
    },
  ];

  for (const [name, text] of [
    ['CURRENT_IMPLEMENTATION_STATUS.md', STATUS],
    ['MASTER_IMPLEMENTATION_CHECKLIST.md', CHECKLIST],
  ] as const) {
    for (const { pattern, why } of denials) {
      assert.ok(
        !pattern.test(text),
        `${name} ${why} — K-02 Authentication is implemented in kernel/authentication`,
      );
    }
  }
});

test('both documents record what K-02 still lacks, item by item', () => {
  // The other half of accuracy. K-02 landing is not permission to stop saying what it cannot do,
  // and the first of these is the one that matters: a reader who believes a verifier ships will
  // wire a login to something that refuses everything.
  const gaps: ReadonlyArray<readonly [string, RegExp]> = [
    ['no verifier ships', /no verifier ships/i],
    ['no API or UI', /no API/i],
    ['no permissions', /\bK-04\b/],
    ['no audit record', /\bK-09\b/],
    ['no events', /\bK-08\b/],
    ['no registration path', /registration/i],
    [
      'nothing applied to a live server',
      /(never been applied|nothing applied to a live|unproven)/i,
    ],
  ];

  for (const [name, text] of [
    ['CURRENT_IMPLEMENTATION_STATUS.md', STATUS],
    ['MASTER_IMPLEMENTATION_CHECKLIST.md', CHECKLIST],
  ] as const) {
    for (const [gap, pattern] of gaps) {
      assert.match(text, pattern, `${name} no longer records that K-02 has ${gap}`);
    }
  }
});

test('K-02 has an evidence block, and the checklist rows point at it', () => {
  assert.match(
    STATUS,
    /### 11\.25 Evidence — FND-004c/,
    'the delivered task has no evidence block, so its rows cannot be substantiated (v3 §56)',
  );
  // The anchor the checklist links to, as GitHub slugifies it.
  const anchor = '#1125-evidence--fnd-004c-k-02-authentication-foundation';
  for (const id of ['K-02', 'P0-33']) {
    const row = CHECKLIST.split(/\r?\n/).find(
      (candidate) => /^\|/.test(candidate) && cellsOf(candidate)[0] === id,
    );
    assert.ok(row !== undefined, `no row for ${id}`);
    assert.ok(row.includes(anchor), `${id}'s row does not link the FND-004c evidence block`);
  }
});

// ---------------------------------------------------------------------------
// The counts the documents assert about themselves
// ---------------------------------------------------------------------------

const MARKERS = ['[ ]', '[~]', '[?]', '[x]', '[!]', '[-]', '[o]'] as const;
const COUNTED_SECTIONS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'J'];

/**
 * Count every status marker in the checklist's tracked sections.
 *
 * One marker per status-bearing cell of every row whose first cell is an item id, in sections A–G
 * and J. §H and §I are registers rather than tracked requirements, which is why the section table
 * in §K sums to the same total as the status table.
 */
function tally(): { readonly byStatus: Map<string, number>; readonly total: number } {
  const byStatus = new Map<string, number>(MARKERS.map((marker) => [marker, 0]));
  let total = 0;
  let section = '';

  for (const line of CHECKLIST.split(/\r?\n/)) {
    const heading = /^##\s+([A-Z0-9]+)\./.exec(line);
    if (heading !== null) section = heading[1] as string;
    if (!/^\|/.test(line) || !COUNTED_SECTIONS.includes(section)) continue;

    const cells = cellsOf(line);
    if (!/^\*{0,2}[A-Z][A-Z0-9]*-[A-Z0-9]+\*{0,2}$/.test(cells[0] ?? '')) continue;

    // Every status-bearing cell, not the first: §B and §C rows carry a contract status *and* an
    // implementation status, and both are tracked items.
    for (const cell of cells.slice(1)) {
      const marker = MARKERS.find((candidate) => cell.startsWith(`\`${candidate}\``));
      if (marker === undefined) continue;
      byStatus.set(marker, (byStatus.get(marker) ?? 0) + 1);
      total += 1;
    }
  }
  return { byStatus, total };
}

test('the §K status counts are the counts in the file', () => {
  const { byStatus, total } = tally();
  assert.equal(total, 474, 'the tracked-item total moved; §K and this counter must agree on why');

  const labels: ReadonlyArray<readonly [string, string]> = [
    ['[ ]', 'NOT STARTED'],
    ['[~]', 'IN PROGRESS'],
    ['[?]', 'NEEDS REVIEW'],
    ['[x]', 'COMPLETE'],
    ['[!]', 'BLOCKED'],
    ['[-]', 'DEFERRED WITH REASON'],
    ['[o]', 'OUT OF SCOPE WITH REASON'],
  ];

  for (const [marker, label] of labels) {
    const counted = byStatus.get(marker) ?? 0;
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, (character) => `\\${character}`);
    const row = new RegExp(`\\|\\s*\`${escaped}\`\\s*${label}\\s*\\|\\s*(\\d+)\\s*\\|`);
    const found = row.exec(CHECKLIST);
    assert.ok(found !== null, `§K has no count row for ${label}`);
    assert.equal(
      Number(found[1]),
      counted,
      `§K claims ${String(found[1])} ${label} items; the file actually has ${counted}`,
    );
  }
});

test('§K reports one COMPLETE contract per implemented component, and no more', () => {
  // The COMPLETE count is the one most likely to drift upwards by accident, because a contract
  // landing is the moment somebody is most tempted to call the component done.
  const contractsComplete = implemented.length;
  const match = /\|\s*`\[x\]`\s*COMPLETE\s*\|\s*(\d+)\s*\|/.exec(CHECKLIST);
  assert.ok(match !== null, '§K has no COMPLETE row');
  assert.equal(
    Number(match[1]) - contractsComplete,
    5,
    'the COMPLETE count should be the five complete P0 items plus one contract per implemented ' +
      'component; if that changed, say which item moved and why',
  );
});

// ---------------------------------------------------------------------------
// What may not be claimed
// ---------------------------------------------------------------------------

test('neither document claims a live PostgreSQL run or a complete component', () => {
  const overclaims: ReadonlyArray<{ readonly pattern: RegExp; readonly why: string }> = [
    {
      pattern: /\bK-0[1-9]\b[^.|]{0,40}\bis complete\b/i,
      why: 'calls a kernel component complete',
    },
    { pattern: /\bPhase 0 (is )?complete\b/i, why: 'calls Phase 0 complete' },
    {
      pattern: /\bmigrations? (have|has) been applied to a live\b/i,
      why: 'claims a migration reached a live server',
    },
  ];

  for (const [name, text] of [
    ['CURRENT_IMPLEMENTATION_STATUS.md', STATUS],
    ['MASTER_IMPLEMENTATION_CHECKLIST.md', CHECKLIST],
  ] as const) {
    for (const { pattern, why } of overclaims) {
      // The documents quote the forbidden phrases in order to forbid them, so a hit is only a
      // failure when it is not inside a "not ..." construction.
      for (const hit of text.matchAll(new RegExp(`[^.]{0,60}${pattern.source}`, 'gi'))) {
        assert.match(
          hit[0],
          /\b(not|never|no|cannot|refus)\b/i,
          `${name} ${why}: "${hit[0].trim().slice(0, 90)}"`,
        );
      }
    }
  }
});
