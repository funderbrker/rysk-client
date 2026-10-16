import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GUARDED_DIRS = ['src/domain', 'src/strategy'];
const ALLOWED_DIRS = ['src/domain', 'src/strategy', 'src/lib'].map((dir) => resolve(ROOT, dir));
// `... from '...'` plus side-effect `import '...'` and dynamic `import('...')`.
const SPECIFIER = /(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g;

function guardedFiles(): string[] {
  return GUARDED_DIRS.map((dir) => resolve(ROOT, dir))
    .filter((dir) => existsSync(dir))
    .flatMap((dir) =>
      readdirSync(dir, { recursive: true, encoding: 'utf8' })
        .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
        .map((name) => join(dir, name)),
    );
}

function importViolations(file: string, source: string): string[] {
  const violations: string[] = [];
  for (const [, specifier = ''] of source.matchAll(SPECIFIER)) {
    if (specifier === 'viem' || specifier.startsWith('viem/')) continue;
    if (specifier.startsWith('node:')) {
      violations.push(`${file}: imports node builtin '${specifier}'`);
    } else if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
      violations.push(`${file}: imports package '${specifier}'`);
    } else {
      const target = resolve(dirname(file), specifier);
      if (!ALLOWED_DIRS.some((dir) => target === dir || target.startsWith(dir + sep))) {
        violations.push(`${file}: imports '${specifier}' outside domain, strategy and lib`);
      }
    }
  }
  return violations;
}

describe('architecture', () => {
  it('flags node builtins, packages other than viem, and relative imports outside the pure layers', () => {
    const file = resolve(ROOT, 'src/domain/example.ts');
    const source = [
      "import { getAddress } from 'viem';",
      "import type { Hex } from 'viem/accounts';",
      "import { stringifyBig } from '../lib/json.ts';",
      "export * from './types.ts';",
      "import { readFileSync } from 'node:fs';",
      "import { z } from 'zod';",
      "import { main } from '../cli/main.ts';",
      "import '../infra/setup.ts';",
      "const lazy = await import('node:path');",
    ].join('\n');

    expect(importViolations(file, source)).toEqual([
      `${file}: imports node builtin 'node:fs'`,
      `${file}: imports package 'zod'`,
      `${file}: imports '../cli/main.ts' outside domain, strategy and lib`,
      `${file}: imports '../infra/setup.ts' outside domain, strategy and lib`,
      `${file}: imports node builtin 'node:path'`,
    ]);
  });

  it('keeps src/domain and src/strategy free of I/O dependencies', () => {
    const violations = guardedFiles().flatMap((file) => importViolations(file, readFileSync(file, 'utf8')));
    expect(violations).toEqual([]);
  });
});
