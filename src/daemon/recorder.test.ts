import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Clock } from '../lib/time.ts';
import { Recorder, type RecorderEnvelope } from './recorder.ts';

const ENVELOPE: RecorderEnvelope = {
  runId: 'run-1',
  mode: 'dry-run',
  codeRev: 'abc1234',
  configHash: 'cfg-9',
};
// The last millisecond of 2026-10-16 UTC.
const END_OF_DAY_MS = Date.UTC(2026, 9, 16, 23, 59, 59, 999);

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rysk-recorder-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A clock reading `atMs`, which the test may move. */
function fixedClock(atMs: number): Clock & { atMs: number } {
  const clock = { atMs, nowMs: () => clock.atMs };
  return clock;
}

function lines(path: string): unknown[] {
  const text = readFileSync(path, 'utf8');
  expect(text.endsWith('\n')).toBe(true);
  return text
    .slice(0, -1)
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);
}

describe('Recorder.append', () => {
  it('writes one line with the envelope and bigints as decimal strings', () => {
    const dataDir = tempDir();
    const recorder = new Recorder({ dataDir, envelope: ENVELOPE, clock: fixedClock(END_OF_DAY_MS) });

    recorder.append('quotes', { a: 1n });

    expect(lines(join(dataDir, 'quotes', '2026-10-16.jsonl'))).toEqual([
      { v: 1, kind: 'quotes', tsMs: END_OF_DAY_MS, ...ENVELOPE, a: '1' },
    ]);
  });

  it('appends one line per record to the same day file', () => {
    const dataDir = tempDir();
    const recorder = new Recorder({ dataDir, envelope: ENVELOPE, clock: fixedClock(END_OF_DAY_MS) });

    recorder.append('decisions', { n: 1 });
    recorder.append('decisions', { n: 2 });

    expect(lines(join(dataDir, 'decisions', '2026-10-16.jsonl'))).toMatchObject([{ n: 1 }, { n: 2 }]);
  });

  it('names the file after the UTC day of the clock reading', () => {
    const dataDir = tempDir();
    const clock = fixedClock(END_OF_DAY_MS);
    const recorder = new Recorder({ dataDir, envelope: ENVELOPE, clock });

    recorder.append('state', { n: 1 });
    clock.atMs = END_OF_DAY_MS + 1;
    recorder.append('state', { n: 2 });

    expect(lines(join(dataDir, 'state', '2026-10-16.jsonl'))).toMatchObject([{ n: 1, tsMs: END_OF_DAY_MS }]);
    expect(lines(join(dataDir, 'state', '2026-10-17.jsonl'))).toMatchObject([
      { n: 2, tsMs: END_OF_DAY_MS + 1 },
    ]);
  });

  it('keeps the envelope fields when the record has keys of the same name', () => {
    const dataDir = tempDir();
    const recorder = new Recorder({ dataDir, envelope: ENVELOPE, clock: fixedClock(END_OF_DAY_MS) });

    recorder.append('executions', {
      v: 9,
      kind: 'other',
      tsMs: 0,
      runId: 'run-x',
      mode: 'live',
      codeRev: 'rev-x',
      configHash: 'cfg-x',
      step: 'gas',
    });

    expect(lines(join(dataDir, 'executions', '2026-10-16.jsonl'))).toEqual([
      { v: 1, kind: 'executions', tsMs: END_OF_DAY_MS, ...ENVELOPE, step: 'gas' },
    ]);
  });

  it('writes nested bigints as decimal strings on a single line', () => {
    const dataDir = tempDir();
    const recorder = new Recorder({ dataDir, envelope: ENVELOPE, clock: fixedClock(END_OF_DAY_MS) });

    recorder.append('public-fills', {
      fill: { priceE18: 25n * 10n ** 18n, strikeE8: 7_850_000_000n },
      premiums6: [1_500_000n],
      note: 'multi\nline',
    });

    const text = readFileSync(join(dataDir, 'public-fills', '2026-10-16.jsonl'), 'utf8');
    expect(text.split('\n')).toHaveLength(2);
    expect(JSON.parse(text)).toMatchObject({
      fill: { priceE18: '25000000000000000000', strikeE8: '7850000000' },
      premiums6: ['1500000'],
      note: 'multi\nline',
    });
  });

  it('creates the data directory and one directory per stream', () => {
    const dataDir = join(tempDir(), 'nested', 'data');
    const recorder = new Recorder({ dataDir, envelope: ENVELOPE, clock: fixedClock(END_OF_DAY_MS) });

    recorder.append('inventory', { n: 1 });
    recorder.append('quotes', { n: 2 });

    expect(lines(join(dataDir, 'inventory', '2026-10-16.jsonl'))).toMatchObject([
      { kind: 'inventory', n: 1 },
    ]);
    expect(lines(join(dataDir, 'quotes', '2026-10-16.jsonl'))).toMatchObject([{ kind: 'quotes', n: 2 }]);
  });

  it('throws when the line cannot be written', () => {
    const dataDir = join(tempDir(), 'not-a-dir');
    writeFileSync(dataDir, 'a file where the data directory should be');
    const recorder = new Recorder({ dataDir, envelope: ENVELOPE, clock: fixedClock(END_OF_DAY_MS) });

    expect(() => recorder.append('quotes', { n: 1 })).toThrow();
  });
});
