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
import { PermissionService } from '../kernel/permissions/index.ts';

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
