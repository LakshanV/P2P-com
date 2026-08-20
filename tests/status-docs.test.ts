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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { KERNEL_COMPONENTS } from '../platform/architecture/manifest.ts';
import { stripNoise } from '../platform/db/migrations.ts';
import { FeatureFlagService } from '../kernel/feature-flags/index.ts';
import { PermissionService } from '../kernel/permissions/index.ts';
import { PolicyService } from '../kernel/policy-engine/index.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KERNEL_DIR = path.join(REPO_ROOT, 'kernel');
const DOCS_DIR = path.join(REPO_ROOT, 'docs');

const STATUS = readFileSync(path.join(DOCS_DIR, 'CURRENT_IMPLEMENTATION_STATUS.md'), 'utf8');
const CHECKLIST = readFileSync(path.join(DOCS_DIR, 'MASTER_IMPLEMENTATION_CHECKLIST.md'), 'utf8');

/** Both governing documents, for the many cases that must hold of each. */
const DOCUMENTS = [
  ['CURRENT_IMPLEMENTATION_STATUS.md', STATUS],
  ['MASTER_IMPLEMENTATION_CHECKLIST.md', CHECKLIST],
] as const;

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

// ---------------------------------------------------------------------------
// K-04 in particular: the surface, the migration, the aggregate, the limits
// ---------------------------------------------------------------------------

test('both documents describe K-04 as the four operations the service actually has', () => {
  // Derived from the class, not written down. If somebody adds a fifth operation — or restores a
  // read — the documents stop describing the component and this fails.
  const surface = new Set<string>();
  let proto: object | null = PermissionService.prototype;
  while (proto !== null && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) surface.add(key);
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  surface.delete('constructor');

  assert.equal(
    surface.size,
    4,
    `K-04's surface is now ${[...surface].sort().join(', ')}; both documents claim four operations ` +
      'and must be rewritten before this test is changed',
  );

  for (const [name, text] of DOCUMENTS) {
    for (const operation of surface) {
      assert.ok(
        text.includes(`\`${operation}\``),
        `${name} does not name K-04's \`${operation}\` operation`,
      );
    }
  }
});

test('neither document presents a K-04 authority-read API that no longer exists', () => {
  // The three removed reads took an identifier and nothing else. A document that still offers one
  // is telling a future caller to build against a hole (§11.29).
  const removed = ['findGrant', 'findDecision', 'activePolicy'];
  const service = PermissionService.prototype as unknown as Record<string, unknown>;

  for (const name of removed) {
    assert.equal(service[name], undefined, `${name} is back on the service; §11.29 was undone`);
  }

  for (const [name, text] of DOCUMENTS) {
    // Fenced blocks quote the old surface, which is how the removal is recorded. What is checked
    // is the claim the prose makes around them.
    const prose = text.replace(/^```[\s\S]*?^```/gm, '');
    for (const method of removed) {
      // A mention is fine — the documents record the removal — but only in a paragraph that says
      // it is gone. An offered capability is not.
      for (const paragraph of prose.split(/\n\s*\n/)) {
        if (!new RegExp(`\\b${method}\\b`).test(paragraph)) continue;
        assert.match(
          paragraph,
          // Past tense or an explicit removal. What fails is a paragraph that offers one of these
          // in the present tense, which is a document telling a caller to build against a hole.
          /\b(remov|delet|no longer|absent|gone|earlier revision|rather than guard|no way|took|returned|exposed|were|was)\b/i,
          `${name} still offers K-04's ${method} as a capability: "${paragraph.trim().slice(0, 140)}"`,
        );
      }
    }
    assert.match(
      text,
      /no way (for a caller )?to read (a grant|authority)/i,
      `${name} does not record that K-04 has no way to read authority back`,
    );
  }
});

test('the K-04 suite sizes quoted in the status document are the sizes on disk', () => {
  // Every count is derived by counting the suites. A quoted number that drifts from the file is
  // the failure mode this whole test file exists for.
  const suites = [
    'permissions',
    'permissions-decisions',
    'permissions-administration',
    'permissions-repository',
    'permissions-idempotency',
    'permissions-concurrency',
  ] as const;

  let total = 0;
  for (const suite of suites) {
    const source = readFileSync(path.join(REPO_ROOT, 'tests', `${suite}.test.ts`), 'utf8');
    const cases = source.split(/^test\(/m).length - 1;
    assert.ok(cases > 0, `tests/${suite}.test.ts has no top-level cases; the convention moved`);
    total += cases;
    assert.match(
      STATUS,
      new RegExp(`\`${suite}\` ${cases}\\b`),
      `§1 does not report tests/${suite}.test.ts as ${cases} cases, which is what it holds`,
    );
  }

  assert.match(
    STATUS,
    new RegExp(`K-04 accounts for ${total} of them`),
    `§1 must report ${total} K-04 cases, the sum of the six suites on disk`,
  );
});

test('the verification aggregate is the same number everywhere it is quoted', () => {
  // Nothing here can run the suite, so this cannot check the number is true. It can check the
  // document does not disagree with itself, which is how a stale aggregate actually survives:
  // one place gets updated and the other does not.
  const summary = /\| Tests \| (\d+) passing \(`npm test`, exit 0\)/.exec(STATUS);
  assert.ok(summary !== null, '§1 has no test-count row');
  const aggregate = Number(summary[1]);

  const quoted = [...STATUS.matchAll(/npm run verify\s+exit 0\s+tests (\d+), pass (\d+)/g)];
  assert.ok(quoted.length > 0, 'no evidence block quotes an npm run verify result');

  for (const [, tests, passing] of quoted) {
    assert.equal(tests, passing, `an evidence block quotes ${tests} tests but ${passing} passing`);
  }

  // The most recent block is the landed state, and §1 must agree with it.
  const last = quoted[quoted.length - 1];
  assert.ok(last !== undefined, 'no evidence block quotes an npm run verify result');
  const latest = Number(last[1]);
  assert.equal(
    aggregate,
    latest,
    `§1 reports ${aggregate} passing tests; the last evidence block reports ${latest}`,
  );
});

test('migration 0009 is the repaired file the status document describes', () => {
  // Both halves matter. The line count is derived from the file, so a document quoting a stale
  // number fails; and the structural check is the repair itself (§11.29) — 0009 was committed as
  // 2389 lines with sixteen COMMIT statements, and no gate in this repository parses SQL, so this
  // is the only thing standing between that recurring and nobody noticing again.
  const file = path.join(
    REPO_ROOT,
    'db',
    'migrations',
    '0009_create_kernel_permissions_schema.up.sql',
  );
  const sql = readFileSync(file, 'utf8');
  const lines = sql.split('\n').length - 1;

  assert.equal(
    (sql.match(/^BEGIN;$/gm) ?? []).length,
    1,
    'migration 0009 must open exactly one transaction — the runner owns it',
  );
  assert.equal(
    (sql.match(/^COMMIT;$/gm) ?? []).length,
    1,
    'migration 0009 has more than one COMMIT; the duplication repaired in §11.29 is back',
  );
  assert.ok(
    !/~ '\^\[0-9a-f\]\{64\}$/m.test(sql),
    'a fingerprint CHECK in migration 0009 has an unterminated regex literal again (§11.29)',
  );

  assert.match(
    STATUS,
    new RegExp(`\\*\\*${lines} lines\\*\\*`),
    `§11.29 must report migration 0009 as ${lines} lines, which is what is on disk`,
  );
});

test('both documents record what K-04 still lacks, item by item', () => {
  // The other half of accuracy, mirroring the K-02 gap test above. K-04 landing and being
  // corrected three times is not permission to stop saying what it cannot do.
  const gaps: ReadonlyArray<readonly [string, RegExp]> = [
    ['no caller', /nothing calls (it|K-04)/i],
    ['no API or UI', /no API/i],
    ['no policy studio', /no policy studio/i],
    ['no audit record', /\bK-09\b/],
    ['no events', /\bK-08\b/],
    ['no operational role matrix', /no operational role matrix/i],
    ['nothing applied to a live server', /nothing applied to a live server/i],
  ];

  for (const [name, text] of DOCUMENTS) {
    for (const [gap, pattern] of gaps) {
      assert.match(text, pattern, `${name} no longer records that K-04 has ${gap}`);
    }
  }
});

test('every FND-004d correction has a block, and the checklist points at all of them', () => {
  // Derived from the headings themselves: add a §11.30 correction and forget to link it, and this
  // fails. The corrections are the most serious defects in the register (§7) and the row that
  // describes the component is where a reader will look for them.
  const headings = [...STATUS.matchAll(/^### (11\.\d+) Correction — FND-004d (.+)$/gm)];
  assert.ok(
    headings.length >= 3,
    `FND-004d has ${headings.length} correction blocks; three security corrections are recorded ` +
      'in §7 and each needs its own block (v3 §56)',
  );

  const k04Row = kernelRow('K-04').join(' | ');
  for (const [, section] of headings) {
    assert.ok(section !== undefined, 'a correction heading carries no section number');
    const anchor = `#${section.replace('.', '')}`;
    assert.ok(
      k04Row.includes(anchor),
      `the checklist K-04 row does not link §${section}, so the correction is invisible from it`,
    );
    assert.ok(
      STATUS.includes(`§${section}`),
      `§${section} is never referenced from anywhere in the status document`,
    );
  }
});

test('the next task is not one that has already been delivered', () => {
  // The failure this catches is specific and has happened: a task is selected, delivered, and the
  // selection stays, so the next reader builds it again.
  const selection = /Next genuinely unblocked task:\s*\*{0,2}([A-Z]+-\d+[a-z]?)/.exec(STATUS);
  const next = selection?.[1];
  assert.ok(next !== undefined, '§8 no longer names a next task');

  assert.ok(
    !new RegExp(`### 11\\.\\d+ Evidence — ${next}\\b`).test(STATUS),
    `§8 selects ${next}, which already has an evidence block — it has been delivered`,
  );

  // And it must be a component the checklist agrees is unbuilt, when it names one.
  const named = /Next genuinely unblocked task:[^\n]*?\b(K-\d\d)\b/.exec(STATUS)?.[1];
  if (named !== undefined) {
    const implementation = kernelRow(named)[3] ?? '';
    assert.match(
      implementation,
      /\[ \]|NOT STARTED/,
      `§8 selects ${named}, which the checklist already reports as started`,
    );
  }
});

// ---------------------------------------------------------------------------
// K-07 in particular: delivered, honestly incomplete, and not still "next"
// ---------------------------------------------------------------------------

test('both documents describe K-07 as the five operations the service actually has', () => {
  // Derived from the class. A sixth operation — or a read of stored flag state — stops both
  // documents describing the component, and this fails before a reader is misled.
  const surface = new Set<string>();
  let proto: object | null = FeatureFlagService.prototype;
  while (proto !== null && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) surface.add(key);
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  surface.delete('constructor');

  assert.deepEqual(
    [...surface].sort(),
    ['activate', 'evaluate', 'kill', 'publish', 'retire'],
    `K-07's surface is now ${[...surface].sort().join(', ')}; both documents describe the old one`,
  );

  for (const [name, text] of DOCUMENTS) {
    for (const operation of ['kill', 'activat', 'rollout']) {
      assert.ok(
        text.toLowerCase().includes(operation),
        `${name} does not describe K-07's ${operation}…`,
      );
    }
  }
});

test('neither document claims feature flags are absent, unbuilt or the next task', () => {
  const denials: ReadonlyArray<{ readonly pattern: RegExp; readonly why: string }> = [
    { pattern: /\|\s*Feature flags\s*\|\s*Absent\s*\|/i, why: 'lists Feature flags as absent' },
    {
      pattern: /\bK-07\b[^.|]{0,60}\b(does not exist|is absent|is not built|is unbuilt)\b/i,
      why: 'states K-07 does not exist',
    },
    {
      pattern: /next genuinely unblocked task:\s*\*{0,2}FND-004e/i,
      why: 'still selects FND-004e as the next task, which has been delivered',
    },
    {
      pattern: /\|\s*P0-37\s*\|[^|]*\|\s*`\[ \]`/,
      why: 'still marks P0-37 Feature flags NOT STARTED',
    },
    {
      pattern: /\bK-07\b[^.|]{0,40}\bis the only one that has never been started\b/i,
      why: 'still calls K-07 the unstarted component of B-2',
    },
  ];

  for (const [name, text] of DOCUMENTS) {
    for (const { pattern, why } of denials) {
      assert.ok(
        !pattern.test(text),
        `${name} ${why} — K-07 Feature Flags is implemented in kernel/feature-flags`,
      );
    }
  }
});

test('both documents record what K-07 still lacks, item by item', () => {
  // The first of these is the one that matters: a reader who believes something is gated by a flag
  // will not add the gate.
  const gaps: ReadonlyArray<readonly [string, RegExp]> = [
    ['no caller', /nothing evaluates a flag/i],
    ['no API or UI', /no API/i],
    ['no audit record', /\bK-09\b/],
    ['no events', /\bK-08\b/],
    [
      'unauthenticated administration',
      /administration is not authenticated|no K-02 authentication/i,
    ],
    ['no control plane', /no control plane/i],
    ['nothing applied to a live server', /nothing applied to a live server/i],
  ];

  for (const [name, text] of DOCUMENTS) {
    for (const [gap, pattern] of gaps) {
      assert.match(text, pattern, `${name} no longer records that K-07 has ${gap}`);
    }
  }
});

test('the K-07 suite sizes quoted in the status document are the sizes on disk', () => {
  const suites = [
    'feature-flags',
    'feature-flags-evaluation',
    'feature-flags-concurrency',
    'feature-flags-rollout',
  ] as const;

  for (const suite of suites) {
    const source = readFileSync(path.join(REPO_ROOT, 'tests', `${suite}.test.ts`), 'utf8');
    const cases = source.split(/^test\(/m).length - 1;
    assert.ok(cases > 0, `tests/${suite}.test.ts has no top-level cases; the convention moved`);
    assert.match(
      STATUS,
      new RegExp(`\`${suite}\` ${cases}\\b`),
      `§1 does not report tests/${suite}.test.ts as ${cases} cases, which is what it holds`,
    );
  }
});

test('migration 0010 is the file the status document and the contract describe', () => {
  // Structural, for the same reason 0009's check exists: no gate in this repository parses SQL, so
  // this is the only thing that would notice the file being mangled by an automated edit (§11.29).
  const file = path.join(
    REPO_ROOT,
    'db',
    'migrations',
    '0010_create_kernel_feature_flags_schema.up.sql',
  );
  const sql = readFileSync(file, 'utf8');

  assert.equal(
    (sql.match(/^BEGIN;$/gm) ?? []).length,
    1,
    'migration 0010 must open exactly one transaction — the runner owns it',
  );
  assert.equal(
    (sql.match(/^COMMIT;$/gm) ?? []).length,
    1,
    'migration 0010 has more than one COMMIT, which is the 0009 corruption signature (§11.29)',
  );
  assert.equal(
    (sql.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length,
    3,
    'the status document and the contract both say K-07 owns three tables',
  );
  assert.equal(
    (sql.match(/BEFORE UPDATE OR DELETE ON/g) ?? []).length,
    3,
    'one append-only trigger per table, or the append-only claim is not enforced',
  );

  // Derived, not pinned: the exact count belongs to the sibling test that reads the directory, and
  // a second hardcoded copy would be a second thing to keep in step.
  assert.match(STATUS, /\d+ forward \+ \d+ rollback/, '§1 does not report the migration count');
});

test('the migration count in §1 is the number of migrations on disk', () => {
  const files = readdirSync(path.join(REPO_ROOT, 'db', 'migrations'));
  const up = files.filter((file) => file.endsWith('.up.sql')).length;
  const down = files.filter((file) => file.endsWith('.down.sql')).length;
  assert.equal(up, down, 'every forward migration needs its rollback');
  assert.match(
    STATUS,
    new RegExp(`\\| Migrations \\| ${up} forward \\+ ${down} rollback`),
    `§1 must report ${up} forward and ${down} rollback migrations, which is what is on disk`,
  );
});

test('build step B-2 is reported as covered, and B-3 is where the next task comes from', () => {
  // Derived from the checklist's own build-step column: if any B-2 component is still unstarted,
  // the claim in §8 is false and the next task was selected from the wrong step.
  const unstartedInStep = (step: string): string[] =>
    CHECKLIST.split(/\r?\n/)
      .filter((line) => /^\| K-\d\d /.test(line))
      .map(cellsOf)
      .filter((cells) => cells.at(-1) === step && /\[ \]/.test(cells[3] ?? ''))
      .map((cells) => cells[0] ?? '');

  assert.deepEqual(
    unstartedInStep('B-1'),
    [],
    'a B-1 component is unstarted, so B-1 is not covered',
  );
  assert.deepEqual(
    unstartedInStep('B-2'),
    [],
    'a B-2 component is unstarted; §8 claims B-2 is covered and selects from B-3',
  );
  assert.ok(unstartedInStep('B-3').length > 0, 'B-3 is complete; §8 must select from a later step');
});

// ---------------------------------------------------------------------------
// K-07 in particular: present, incomplete, and honestly counted
// ---------------------------------------------------------------------------

test('K-07 is reported as a foundation: neither complete nor merely a contract', () => {
  // Both halves. The checklist cells are derived from the filesystem by the general test above;
  // what this adds is that the *prose* agrees, in both documents, and does not over-claim.
  const cells = kernelRow('K-07');
  assert.ok((cells[2] ?? '').startsWith('`[x]`'), 'the K-07 contract row is not COMPLETE');
  assert.ok(
    (cells[3] ?? '').startsWith('`[~]`'),
    'the K-07 implementation row is not IN PROGRESS; a delivered foundation is neither absent nor done',
  );

  for (const [name, text] of DOCUMENTS) {
    for (const overclaim of [
      /\bK-07\b[^.|]{0,40}\bis complete\b/i,
      /feature flags[^.|]{0,30}\bare complete\b/i,
    ]) {
      for (const hit of text.matchAll(new RegExp(`[^.]{0,60}${overclaim.source}`, 'gi'))) {
        assert.match(
          hit[0],
          /\b(not|never|no|cannot|refus)\b/i,
          `${name} calls K-07 complete: "${hit[0].trim().slice(0, 90)}"`,
        );
      }
    }
  }
});

test('K-07 has an evidence block, and the checklist rows point at it', () => {
  assert.match(
    STATUS,
    /### 11\.30 Evidence — FND-004e/,
    'the delivered task has no evidence block, so its rows cannot be substantiated (v3 §56)',
  );

  const anchor = '#1130-evidence--fnd-004e-k-07-feature-flags-foundation';
  for (const id of ['K-07', 'P0-37']) {
    const row = CHECKLIST.split(/\r?\n/).find(
      (candidate) => /^\|/.test(candidate) && cellsOf(candidate)[0] === id,
    );
    assert.ok(row !== undefined, `no row for ${id}`);
    assert.ok(row.includes(anchor), `${id}'s row does not link the FND-004e evidence block`);
  }
});

test('the live-suite skip is reported as a skip, never as evidence', () => {
  // The claim this protects is the one it would be easiest to launder: 48 opt-in cases exist, all
  // 48 skip, and a document that quoted them as passing would be claiming a live PostgreSQL run
  // this repository has never made.
  const quoted = [...STATUS.matchAll(/tests (\d+), skipped (\d+)/g)];
  for (const [, total, skipped] of quoted) {
    assert.equal(
      total,
      skipped,
      `an evidence block quotes ${String(total)} live tests with only ${String(skipped)} skipped; ` +
        'a live suite that partly ran is a different claim and needs its own evidence',
    );
  }

  for (const [name, text] of DOCUMENTS) {
    assert.match(
      text,
      /a skipped run is not evidence/i,
      `${name} no longer states that a skipped run proves nothing`,
    );
    for (const hit of text.matchAll(/[^.]{0,80}\bintegration (tests?|suites?) (pass|passed)\b/gi)) {
      assert.match(
        hit[0],
        /\b(not|never|no|would|skip)\b/i,
        `${name} claims the integration suite passed: "${hit[0].trim().slice(0, 90)}"`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// K-06 in particular: delivered, honestly incomplete, and not still "next"
// ---------------------------------------------------------------------------

test('both documents describe K-06 as the five operations the service actually has', () => {
  const surface = new Set<string>();
  let proto: object | null = PolicyService.prototype;
  while (proto !== null && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) surface.add(key);
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  surface.delete('constructor');

  assert.deepEqual(
    [...surface].sort(),
    ['activate', 'draft', 'evaluate', 'publish', 'retire'],
    `K-06's surface is now ${[...surface].sort().join(', ')}; both documents describe the old one`,
  );

  for (const [name, text] of DOCUMENTS) {
    for (const step of ['draft', 'publish', 'activat', 'retire']) {
      assert.ok(
        text.toLowerCase().includes(step),
        `${name} does not describe K-06's ${step}… step of the lifecycle`,
      );
    }
  }
});

test('neither document claims the policy engine is absent, unbuilt or the next task', () => {
  const denials: ReadonlyArray<{ readonly pattern: RegExp; readonly why: string }> = [
    { pattern: /\|\s*Policy engine\s*\|\s*Absent\s*\|/i, why: 'lists the policy engine as absent' },
    {
      pattern:
        /\bK-06\b[^.|]{0,60}\b(does not exist|is absent|is not built|is unbuilt|is not started)\b/i,
      why: 'states K-06 does not exist',
    },
    {
      pattern: /next genuinely unblocked task:\s*\*{0,2}FND-005b/i,
      why: 'still selects FND-005b as the next task, which has been delivered',
    },
    {
      pattern: /\bK-06\b[^.|]{0,50}\bthe first component of build step B-3\b/i,
      why: 'still describes K-06 as the task to be taken next',
    },
  ];

  for (const [name, text] of DOCUMENTS) {
    for (const { pattern, why } of denials) {
      assert.ok(
        !pattern.test(text),
        `${name} ${why} — K-06 Policy Engine is implemented in kernel/policy-engine`,
      );
    }
  }
});

test('both documents record what K-06 still lacks, item by item', () => {
  // The first is the one that matters most: a reader who believes an amount somewhere has been
  // priced by a policy will not notice that nothing has.
  const gaps: ReadonlyArray<readonly [string, RegExp]> = [
    ['no caller', /nothing evaluates a policy/i],
    ['no API or UI', /no API/i],
    ['no policy studio', /no policy studio|no studio/i],
    ['no approval workflow', /no approval workflow/i],
    ['unauthenticated authoring', /authoring is not authenticated|no K-02 authentication/i],
    ['no audit record', /\bK-09\b/],
    ['no events', /\bK-08\b/],
    ['nothing applied to a live server', /nothing applied to a live server/i],
  ];

  for (const [name, text] of DOCUMENTS) {
    for (const [gap, pattern] of gaps) {
      assert.match(text, pattern, `${name} no longer records that K-06 has ${gap}`);
    }
  }
});

test('both documents record the guarantee K-06 exists for, and its two hard rules', () => {
  // These three claims are the component. A document that stopped making them would describe
  // something that merely stores rules.
  for (const [name, text] of DOCUMENTS) {
    assert.match(
      text,
      /returns the (policy )?version id/i,
      `${name} no longer records that every evaluation returns the version a transaction pins`,
    );
    assert.match(
      text,
      /no floating point|exact decimal/i,
      `${name} no longer records that K-06 holds no floating-point value`,
    );
    assert.match(
      text,
      /(ties|equally specific)[^.]{0,80}refus/i,
      `${name} no longer records that an ambiguous precedence is refused rather than resolved`,
    );
  }
});

test('the K-06 suite sizes quoted in the status document are the sizes on disk', () => {
  const suites = [
    'policy-engine',
    'policy-engine-evaluation',
    'policy-engine-decimal',
    'policy-engine-lifecycle',
    'policy-engine-repository',
  ] as const;

  let total = 0;
  for (const suite of suites) {
    const source = readFileSync(path.join(REPO_ROOT, 'tests', `${suite}.test.ts`), 'utf8');
    const cases = source.split(/^test\(/m).length - 1;
    assert.ok(cases > 0, `tests/${suite}.test.ts has no top-level cases; the convention moved`);
    total += cases;
    assert.match(
      STATUS,
      new RegExp(`\`${suite}\` ${cases}\\b`),
      `§1 does not report tests/${suite}.test.ts as ${cases} cases, which is what it holds`,
    );
  }
  assert.match(
    STATUS,
    new RegExp(`K-06 accounts for ${total} of them`),
    `§1 must report ${total} K-06 cases, the sum of the five suites on disk`,
  );
});

test('migration 0011 is the file the status document and the contract describe', () => {
  const file = path.join(
    REPO_ROOT,
    'db',
    'migrations',
    '0011_create_kernel_policy_engine_schema.up.sql',
  );
  const sql = readFileSync(file, 'utf8');

  assert.equal(
    (sql.match(/^BEGIN;$/gm) ?? []).length,
    1,
    'migration 0011 must open exactly one transaction — the runner owns it',
  );
  assert.equal(
    (sql.match(/^COMMIT;$/gm) ?? []).length,
    1,
    'migration 0011 has more than one COMMIT, which is the 0009 corruption signature (§11.29)',
  );
  assert.equal(
    (sql.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length,
    4,
    'the status document and the contract both say K-06 owns four tables',
  );
  assert.equal(
    (sql.match(/BEFORE UPDATE OR DELETE ON/g) ?? []).length,
    4,
    'one append-only trigger per table, or the append-only claim is not enforced',
  );

  // The claim that would be most expensive to lose, and cheapest to lose by accident.
  //
  // Scanned over the *statements* rather than the raw file: 0011's header says in prose that there
  // is no `double precision` column in the schema and never will be, and a check that failed on
  // its own documentation would be one somebody deletes rather than fixes.
  const statements = stripNoise(sql);
  for (const type of ['double precision', 'real', 'float4', 'float8', 'money']) {
    assert.ok(
      !new RegExp(`\\b${type.replace(' ', '\\s+')}\\b`, 'i').test(statements),
      `migration 0011 declares a ${type} column; K-06 holds no floating-point value`,
    );
  }
});

test('migration 0012 is the file the status document describes', () => {
  const file = path.join(
    REPO_ROOT,
    'db',
    'migrations',
    '0012_create_kernel_commerce_unit_registry_schema.up.sql',
  );
  const sql = readFileSync(file, 'utf8');

  assert.equal(
    (sql.match(/^BEGIN;$/gm) ?? []).length,
    1,
    'migration 0012 must open exactly one transaction — the runner owns it',
  );
  assert.equal(
    (sql.match(/^COMMIT;$/gm) ?? []).length,
    1,
    'migration 0012 has more than one COMMIT, which is the 0009 corruption signature (§11.29)',
  );
  assert.equal(
    (sql.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length,
    3,
    'the status document says K-11 owns three tables: version, activation, retirement',
  );
  assert.equal(
    (sql.match(/BEFORE UPDATE OR DELETE ON/g) ?? []).length,
    3,
    'one append-only trigger per table, or the append-only claim is not enforced',
  );
  assert.equal(
    (sql.match(/CREATE UNIQUE INDEX IF NOT EXISTS/g) ?? []).length,
    2,
    'the two partial unique indexes are what make two versions in force at once impossible',
  );

  // 0012's own header: no price, no currency, no conversion factor, no tax column. Scanned over
  // the statements rather than the file, so the sentence promising it cannot fail its own check.
  const statements = stripNoise(sql);
  for (const type of ['money', 'double precision', 'real', 'float4', 'float8']) {
    assert.ok(
      !new RegExp(`\\b${type.replace(' ', '\\s+')}\\b`, 'i').test(statements),
      `migration 0012 declares a ${type} column; K-11 holds no amount and no currency`,
    );
  }
});

test('the trigger inventory in §1 is the triggers on disk, not the count when it was written', () => {
  // This sentence went stale the moment a migration landed: §1 said seventeen triggers across
  // seventeen tables while twenty were on disk. A prose number nothing derives is a number that
  // is right until the next slice, so it is derived here.
  const words = [
    'zero',
    'one',
    'two',
    'three',
    'four',
    'five',
    'six',
    'seven',
    'eight',
    'nine',
    'ten',
    'eleven',
    'twelve',
    'thirteen',
    'fourteen',
    'fifteen',
    'sixteen',
    'seventeen',
    'eighteen',
    'nineteen',
    'twenty',
    'twenty-one',
    'twenty-two',
    'twenty-three',
    'twenty-four',
  ];

  const migrations = path.join(REPO_ROOT, 'db', 'migrations');
  const guarded = readdirSync(migrations)
    .filter((file) => file.endsWith('.up.sql'))
    .flatMap((file) => [
      ...readFileSync(path.join(migrations, file), 'utf8').matchAll(
        /CREATE TRIGGER \w+\s+BEFORE [A-Z ]*ON ([a-z0-9_]+\.[a-z0-9_]+)/g,
      ),
    ])
    .map((match) => String(match[1]));

  assert.ok(guarded.length > 0, 'no triggers found; the regex no longer matches the migrations');
  assert.equal(
    new Set(guarded).size,
    guarded.length,
    'two triggers guard one table, so "one per table" is no longer the shape §1 describes',
  );

  const claim = /(\w+(?:-\w+)?) triggers across (\w+(?:-\w+)?) tables/i.exec(STATUS);
  assert.ok(claim !== null, '§1 no longer reports how many triggers refuse a mutation');
  const expected = words[guarded.length];
  assert.ok(expected !== undefined, `${guarded.length} triggers is off the end of the scale`);
  assert.equal(
    String(claim[1]).toLowerCase(),
    expected,
    `§1 says "${String(claim[0])}" and ${guarded.length} triggers are on disk`,
  );
  assert.equal(
    String(claim[2]).toLowerCase(),
    expected,
    `§1 says "${String(claim[0])}" and ${new Set(guarded).size} tables carry one`,
  );
});

// ---------------------------------------------------------------------------
// The nine-component state, and the aggregates that describe it
// ---------------------------------------------------------------------------

test('the prose inventory in both documents counts the components on disk', () => {
  // The derived-counts test above checks §1's table cells. This checks the *sentences*, which are
  // what a reader actually reads and which have gone stale twice: "seven kernel components" and
  // "Eight components — K-01 … K-09" both survived a slice that had already made them false, the
  // second while listing nine ids in the same breath.
  const words = [
    'zero',
    'one',
    'two',
    'three',
    'four',
    'five',
    'six',
    'seven',
    'eight',
    'nine',
    'ten',
    'eleven',
    'twelve',
  ];
  const expected = words[implemented.length];
  assert.ok(expected !== undefined, `${implemented.length} components is off the end of the scale`);

  for (const [name, text] of DOCUMENTS) {
    // Any sentence counting kernel components has to agree with the filesystem.
    const claims = [
      ...text.matchAll(
        /\*{0,2}(\w+)\*{0,2}\s+(?:kernel\s+)?components?\s+(?:now\s+)?(?:have|has)\s+(?:implemented\s+)?(?:cores|foundations)/gi,
      ),
      ...text.matchAll(/\*{0,2}(\w+)\*{0,2}\s+components?\s+—\s+K-01/gi),
    ];
    assert.ok(claims.length > 0, `${name} no longer states how many components exist`);

    for (const claim of claims) {
      const counted = String(claim[1]).toLowerCase();
      assert.equal(
        counted,
        expected,
        `${name} says "${claim[0].trim().slice(0, 70)}" but ${implemented.length} components ` +
          `have a CONTRACT.md on disk`,
      );
    }
  }
});

test('every kernel component on disk is named in both documents’ inventories', () => {
  // A count can be right while the list behind it is wrong. This catches the component that was
  // renumbered into the total but never named, which is how a reader concludes it does not exist.
  for (const [name, text] of DOCUMENTS) {
    for (const component of implemented) {
      assert.ok(
        text.includes(component.id),
        `${name} never mentions ${component.id}, which has a CONTRACT.md on disk`,
      );
    }
  }
});

test('no superseded total is presented as the current one', () => {
  // Each of these was true once and is quoted in a historical evidence block, which is correct.
  // What must not happen is one of them appearing in a *present-tense* claim in §1 or §7 — the two
  // places a reader looks for "where is this repository now".
  // §1 is a level-2 heading, so its row is read from the document directly.
  const superseded = ['702', '819', '931', '1019', '1029', '1118'];

  for (const total of superseded) {
    assert.ok(
      !STATUS.includes(`| Tests | ${total} passing`),
      `§1 reports ${total} passing tests, which is a superseded total`,
    );
  }

  // §7's running tally ends with the current figure, whatever it is; it must not end with an old one.
  const tally = /for (\d+) today/.exec(STATUS);
  assert.ok(tally !== null, '§7 no longer carries a running test total');
  const current = /\| Tests \| (\d+) passing/.exec(STATUS)?.[1];
  assert.equal(
    tally[1],
    current,
    `§7 says the total is ${String(tally[1])} today and §1 says ${String(current)}`,
  );
});

test('the live-PostgreSQL skip aggregate agrees between §1 and the evidence blocks', () => {
  // 49 tests that skip are not 49 tests that pass, and the number is the easiest thing in the
  // document to quietly launder into evidence. §1 and the newest block must say the same thing.
  const summary = /A further (\d+) live-PostgreSQL tests exist and are \*\*skipped\*\*/.exec(
    STATUS,
  );
  assert.ok(summary !== null, '§1 no longer reports the live-suite count as skipped');

  const quoted = [
    ...STATUS.matchAll(/npm run test:integration\s+exit 0\s+tests (\d+), skipped (\d+)/g),
  ];
  assert.ok(quoted.length > 0, 'no evidence block quotes a test:integration result');

  const latest = quoted[quoted.length - 1];
  assert.ok(latest !== undefined);
  assert.equal(latest[1], latest[2], 'an evidence block quotes live tests that did not all skip');
  assert.equal(
    summary[1],
    latest[1],
    `§1 says ${String(summary[1])} live tests exist; the last evidence block ran ${String(latest[1])}`,
  );
});

// ---------------------------------------------------------------------------
// K-06 in particular: what it is, and what it is next
// ---------------------------------------------------------------------------

test('K-06 is reported as a foundation: neither complete nor merely a contract', () => {
  const row = kernelRow('K-06');
  assert.ok(
    (row[2] ?? '').startsWith('`[x]`'),
    'K-06 has a CONTRACT.md on disk but the checklist does not call its contract COMPLETE',
  );
  assert.ok(
    (row[3] ?? '').startsWith('`[~]`'),
    'K-06 is implemented but the checklist does not call its implementation IN PROGRESS',
  );
  assert.equal(row.at(-1), 'B-3', 'K-06 opens build step B-3; the checklist says otherwise');

  // And the guarantee it exists for, which is the one claim that must never be softened: an
  // evaluation that did not return a version id would make v3 §35 unkeepable by any caller.
  for (const [name, text] of DOCUMENTS) {
    assert.match(
      text,
      /pinn?ed?[^.]{0,80}version id|version id[^.]{0,80}pin/i,
      `${name} no longer records that a K-06 evaluation returns the version a record pins`,
    );
  }
});

test('K-06 has an evidence block, and the checklist rows point at it', () => {
  assert.match(
    STATUS,
    /### 11\.31 Evidence — FND-005b/,
    'the delivered task has no evidence block, so its rows cannot be substantiated (v3 §56)',
  );
  const anchor = '#1131-evidence--fnd-005b-k-06-policy-engine-foundation';
  for (const id of ['K-06', 'P0-38']) {
    const row = CHECKLIST.split(/\r?\n/).find(
      (candidate) => /^\|/.test(candidate) && cellsOf(candidate)[0] === id,
    );
    assert.ok(row !== undefined, `no row for ${id}`);
    assert.ok(row.includes(anchor), `${id}'s row does not link the FND-005b evidence block`);
  }
});

test('the next task is K-11, and the checklist agrees it is unbuilt and in B-3', () => {
  // Selected from the dependency order rather than from judgement, so the assertion is that the
  // document still names a component the checklist reports as unstarted — the failure being a
  // selection that has already been delivered, which is how something gets built twice.
  const selection = /Next genuinely unblocked task:[^\n]*?\b(K-\d\d)\b/.exec(STATUS)?.[1];
  assert.equal(selection, 'K-11', '§8 no longer selects K-11 Commerce Unit Registry');

  const row = kernelRow('K-11');
  assert.match(
    row[3] ?? '',
    /\[ \]|NOT STARTED/,
    'K-11 is selected as next but the checklist already reports it as started',
  );
  assert.equal(row.at(-1), 'B-3', 'K-11 is selected from B-3; the checklist places it elsewhere');
  assert.ok(
    !existsSync(path.join(KERNEL_DIR, 'commerce-unit-registry', 'CONTRACT.md')),
    'K-11 has a CONTRACT.md on disk, so selecting it as the next task is stale',
  );
});
