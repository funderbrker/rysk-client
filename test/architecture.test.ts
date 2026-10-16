import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GUARDED_DIRS = ['src/domain', 'src/strategy'];
const PURE_DIRS = ['src/domain', 'src/strategy'].map((dir) => resolve(ROOT, dir));
/** The `src/lib` modules the pure layers may import: `json.ts` (bigint-safe JSON), and `time.ts` for its types only. */
const LIB_JSON = resolve(ROOT, 'src/lib/json.ts');
const LIB_TIME = resolve(ROOT, 'src/lib/time.ts');
// `... from '...'` plus side-effect `import '...'` and dynamic `import('...')`.
const SPECIFIER = /(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g;
// `import type { … } from '...'` and `export type { … } from '...'`, which erase at runtime.
const TYPE_ONLY = /\b(?:import|export)\s+type\s+[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g;
/** Clock, randomness, timers and process state: a pure layer takes time and randomness as inputs. */
const IMPURE_CALLS: [RegExp, string][] = [
  [/\bDate\.now\(/, 'Date.now('],
  [/\bnew Date\(/, 'new Date('],
  [/\bMath\.random\(/, 'Math.random('],
  [/\bsetTimeout\(/, 'setTimeout('],
  [/\bperformance\./, 'performance.'],
  [/\bprocess\./, 'process.'],
];

/** The source files (not tests) under each guarded directory. */
function guardedFiles(): Map<string, string[]> {
  return new Map(
    GUARDED_DIRS.map((dir) => {
      const abs = resolve(ROOT, dir);
      const files = readdirSync(abs, { recursive: true, encoding: 'utf8' })
        .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
        .map((name) => join(abs, name));
      return [dir, files];
    }),
  );
}

function importViolations(file: string, source: string): string[] {
  const typeOnlyEnds = new Set([...source.matchAll(TYPE_ONLY)].map((m) => m.index + m[0].length));
  const violations: string[] = [];
  for (const match of source.matchAll(SPECIFIER)) {
    const specifier = match[1] ?? '';
    if (specifier === 'viem' || specifier.startsWith('viem/')) continue;
    if (specifier.startsWith('node:')) {
      violations.push(`${file}: imports node builtin '${specifier}'`);
    } else if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
      violations.push(`${file}: imports package '${specifier}'`);
    } else {
      const target = resolve(dirname(file), specifier);
      const typeOnly = typeOnlyEnds.has(match.index + match[0].length);
      const pure = PURE_DIRS.some((dir) => target === dir || target.startsWith(dir + sep));
      if (!pure && target !== LIB_JSON && !(target === LIB_TIME && typeOnly)) {
        violations.push(
          `${file}: imports '${specifier}' outside domain, strategy and the allowed lib modules`,
        );
      }
    }
  }
  return violations;
}

function impureCalls(file: string, source: string): string[] {
  return source
    .split('\n')
    .flatMap((line, index) =>
      IMPURE_CALLS.filter(([pattern]) => pattern.test(line)).map(
        ([, name]) => `${file}:${index + 1}: uses ${name}`,
      ),
    );
}

describe('architecture', () => {
  it('flags node builtins, packages other than viem, and relative imports outside the pure layers', () => {
    const file = resolve(ROOT, 'src/domain/example.ts');
    const source = [
      "import { getAddress } from 'viem';",
      "import type { Hex } from 'viem/accounts';",
      "import { stringifyBig } from '../lib/json.ts';",
      "import type { Clock } from '../lib/time.ts';",
      "export * from './types.ts';",
      "import { readFileSync } from 'node:fs';",
      "import { z } from 'zod';",
      "import { main } from '../cli/main.ts';",
      "import '../infra/setup.ts';",
      "const lazy = await import('node:path');",
      "import { sleep } from '../lib/time.ts';",
      "import { type Clock as Tick } from '../lib/time.ts';",
    ].join('\n');

    expect(importViolations(file, source)).toEqual([
      `${file}: imports node builtin 'node:fs'`,
      `${file}: imports package 'zod'`,
      `${file}: imports '../cli/main.ts' outside domain, strategy and the allowed lib modules`,
      `${file}: imports '../infra/setup.ts' outside domain, strategy and the allowed lib modules`,
      `${file}: imports node builtin 'node:path'`,
      `${file}: imports '../lib/time.ts' outside domain, strategy and the allowed lib modules`,
      `${file}: imports '../lib/time.ts' outside domain, strategy and the allowed lib modules`,
    ]);
  });

  it('flags clock, randomness, timer and process use', () => {
    const file = resolve(ROOT, 'src/strategy/example.ts');
    const source = [
      'const a = Date.now();',
      'const b = new Date(0);',
      'const c = Math.random();',
      'setTimeout(() => {}, 1);',
      'const d = performance.now();',
      'const e = process.env.X;',
      'const ok = nowSec + DATE_OFFSET; // a date is an input here',
    ].join('\n');

    expect(impureCalls(file, source)).toEqual([
      `${file}:1: uses Date.now(`,
      `${file}:2: uses new Date(`,
      `${file}:3: uses Math.random(`,
      `${file}:4: uses setTimeout(`,
      `${file}:5: uses performance.`,
      `${file}:6: uses process.`,
    ]);
  });

  it('guards a non-empty set of source files in every guarded directory', () => {
    for (const [dir, files] of guardedFiles()) {
      expect(files.length, dir).toBeGreaterThan(0);
    }
  });

  it('keeps src/domain and src/strategy free of I/O dependencies, the clock, randomness and timers', () => {
    const files = [...guardedFiles().values()].flat();
    const violations = files.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return [...importViolations(file, source), ...impureCalls(file, source)];
    });
    expect(violations).toEqual([]);
  });
});
