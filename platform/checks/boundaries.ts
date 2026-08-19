/**
 * Executable enforcement of the four architectural boundary rules in docs/MODULE_MAP.md:
 *
 *   layer-direction     MR-2, §10.1–10.3 — imports point downward only; no sibling calls
 *   kernel-purity       §10.6            — the kernel never depends on a business module
 *   financial-zone-ai   MR-3, §11 F-1    — the financial authority zone never imports K-13
 *   provider-import     MR-4, §12 A-1    — only K-13 may import a model-provider SDK
 *
 * Imports are extracted with the TypeScript compiler API rather than by regular expression, so
 * multi-line imports, dynamic `import()`, `export … from`, `import … = require()` and
 * commented-out code are all handled exactly.
 *
 * Owned by: FND-001b (platform substrate).
 */

import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import {
  AI_GATEWAY_PATH,
  APP_DEPTH,
  KERNEL_DIRS,
  MODULE_BY_DIR,
  MODULE_LAYER_DEPTH,
  ZONE_DEPTH,
  isInFinancialZone,
  isProviderPackage,
  type Zone,
} from '../architecture/manifest.ts';

export type CheckId = 'layer-direction' | 'kernel-purity' | 'financial-zone-ai' | 'provider-import';

export type Severity = 'P0' | 'P1';

export interface Violation {
  readonly check: CheckId;
  readonly severity: Severity;
  /** Repo-relative path of the offending file, POSIX separators. */
  readonly file: string;
  readonly line: number;
  readonly specifier: string;
  readonly message: string;
}

export interface CheckResult {
  readonly filesScanned: number;
  readonly importsScanned: number;
  readonly violations: readonly Violation[];
}

export interface Unit {
  readonly zone: Zone;
  /** Repo-relative root of the owning unit, e.g. "kernel/ai-gateway" or "modules/orders". */
  readonly id: string;
  readonly depth: number;
  /** True when the directory is absent from the architecture manifest. */
  readonly unregistered: boolean;
}

/** Source roots governed by the boundary rules. Anything else (docs/, tests/) is not scanned. */
const GOVERNED_ROOTS = ['platform', 'kernel', 'design-system', 'modules', 'apps'] as const;

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

const IGNORED_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage']);

/** Path aliases accepted in addition to relative specifiers. */
const ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['@platform/', 'platform/'],
  ['@kernel/', 'kernel/'],
  ['@design-system/', 'design-system/'],
  ['@modules/', 'modules/'],
  ['@apps/', 'apps/'],
];

const toPosix = (p: string): string => p.split(path.sep).join('/');

/** Map a repo-relative path onto the unit that owns it, or null when ungoverned. */
export function classify(repoRelativePath: string): Unit | null {
  const segments = repoRelativePath.split('/').filter(Boolean);
  const root = segments[0];
  if (root === undefined) return null;

  if (root === 'platform') {
    return { zone: 'platform', id: 'platform', depth: ZONE_DEPTH.platform, unregistered: false };
  }
  if (root === 'design-system') {
    return {
      zone: 'design-system',
      id: 'design-system',
      depth: ZONE_DEPTH['design-system'],
      unregistered: false,
    };
  }
  if (root === 'kernel') {
    const dir = segments[1];
    if (dir === undefined) return null;
    return {
      zone: 'kernel',
      id: `kernel/${dir}`,
      depth: ZONE_DEPTH.kernel,
      unregistered: !KERNEL_DIRS.has(dir),
    };
  }
  if (root === 'modules') {
    const dir = segments[1];
    if (dir === undefined) return null;
    const mod = MODULE_BY_DIR.get(dir);
    return {
      zone: 'module',
      id: `modules/${dir}`,
      depth: mod ? MODULE_LAYER_DEPTH[mod.layer] : Number.POSITIVE_INFINITY,
      unregistered: mod === undefined,
    };
  }
  if (root === 'apps') {
    const dir = segments[1];
    if (dir === undefined) return null;
    return { zone: 'app', id: `apps/${dir}`, depth: APP_DEPTH, unregistered: false };
  }
  return null;
}

/** Resolve an import specifier to a repo-relative path, or null when it is an external package. */
function resolveInternal(specifier: string, importerRepoRelative: string): string | null {
  for (const [alias, target] of ALIASES) {
    if (specifier.startsWith(alias)) return `${target}${specifier.slice(alias.length)}`;
  }
  if (!specifier.startsWith('.')) return null;
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(importerRepoRelative), specifier),
  );
  return resolved.replace(/^\.\//, '');
}

export interface ExtractedImport {
  readonly specifier: string;
  readonly line: number;
}

/** Extract every module specifier from a source file using the TypeScript parser. */
export function extractImports(fileName: string, text: string): ExtractedImport[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false);
  const found: ExtractedImport[] = [];

  const record = (node: ts.Node): void => {
    if (!ts.isStringLiteralLike(node)) return;
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    found.push({ specifier: node.text, line: line + 1 });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) record(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        record(node.moduleReference.expression);
      }
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const first = node.arguments[0];
      if ((isDynamicImport || isRequire) && first !== undefined) record(first);
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(source, visit);
  return found;
}

function collectSourceFiles(rootDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) out.push(full);
    }
  };
  for (const root of GOVERNED_ROOTS) {
    const full = path.join(rootDir, root);
    if (fs.existsSync(full)) walk(full);
  }
  return out;
}

/** Run all four boundary checks over the governed source roots beneath `rootDir`. */
export function checkBoundaries(rootDir: string): CheckResult {
  const files = collectSourceFiles(rootDir);
  const violations: Violation[] = [];
  let importsScanned = 0;

  for (const absolute of files) {
    const file = toPosix(path.relative(rootDir, absolute));
    const importer = classify(file);
    if (importer === null) continue;

    if (importer.unregistered) {
      violations.push({
        check: 'layer-direction',
        severity: 'P1',
        file,
        line: 1,
        specifier: importer.id,
        message: `${importer.id} is not registered in platform/architecture/manifest.ts, so its layer is unknown and its imports cannot be checked. Register the unit or remove it.`,
      });
    }

    const text = fs.readFileSync(absolute, 'utf8');
    for (const { specifier, line } of extractImports(file, text)) {
      importsScanned++;

      if (isProviderPackage(specifier) && importer.id !== AI_GATEWAY_PATH) {
        violations.push({
          check: 'provider-import',
          severity: 'P1',
          file,
          line,
          specifier,
          message: `${importer.id} imports the model-provider SDK "${specifier}". Only ${AI_GATEWAY_PATH} may import a provider SDK (MODULE_MAP.md §12, rule A-1); address AI by task name instead.`,
        });
        continue;
      }

      const targetPath = resolveInternal(specifier, file);
      if (targetPath === null) continue;
      const target = classify(targetPath);
      if (target === null) continue;

      if (importer.zone === 'kernel' && target.zone !== 'kernel' && target.zone !== 'platform') {
        violations.push({
          check: 'kernel-purity',
          severity: 'P1',
          file,
          line,
          specifier,
          message: `Kernel component ${importer.id} imports ${target.id}. The kernel may never depend on a business module, the design system or an app (MODULE_MAP.md §10.6); move the business rule out of the kernel.`,
        });
        continue;
      }

      if (isInFinancialZone(file) && target.id === AI_GATEWAY_PATH) {
        violations.push({
          check: 'financial-zone-ai',
          severity: 'P0',
          file,
          line,
          specifier,
          message: `${file} is inside the deterministic financial authority zone and imports ${AI_GATEWAY_PATH}. AI must never be the financial authority (MODULE_MAP.md §11, rule F-1); this is a P0 defect and stops all progression.`,
        });
        continue;
      }

      if (target.id === importer.id) continue;
      // The kernel is internally layered (K-01 -> K-02/K-03 -> K-04), but that ordering is not
      // checked here: at this depth the kernel is treated as one layer.
      if (importer.zone === 'kernel' && target.zone === 'kernel') continue;

      if (!(target.depth < importer.depth)) {
        const reason =
          target.depth === importer.depth
            ? 'Same-layer modules must communicate by event, not by direct call (MODULE_MAP.md §10.3).'
            : 'Imports may only point downward; use an event for upward notification (MODULE_MAP.md §10.1–10.2).';
        violations.push({
          check: 'layer-direction',
          severity: 'P1',
          file,
          line,
          specifier,
          message: `${importer.id} (depth ${importer.depth}) imports ${target.id} (depth ${target.depth}). ${reason}`,
        });
      }
    }
  }

  return { filesScanned: files.length, importsScanned, violations };
}

export const CHECK_IDS: readonly CheckId[] = [
  'layer-direction',
  'kernel-purity',
  'financial-zone-ai',
  'provider-import',
];
