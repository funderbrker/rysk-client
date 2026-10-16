import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type StatusFile, stopFilePresent, writeStatus, writeStopFile } from './status.ts';

const STATUS: StatusFile = {
  tsMs: 1_792_195_200_000,
  health: 'holding',
  holdReasons: { put: 'interval', call: 'basis-unreliable' },
  halted: false,
  lastTradeAtSec: 1_792_190_000,
  tick: 42,
  mode: 'dry-run',
};
const ISO_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rysk-status-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('writeStatus', () => {
  it('writes STATUS.json that reads back equal to the input, indented, with no temp file left', () => {
    const dataDir = tempDir();

    writeStatus(dataDir, STATUS);

    const text = readFileSync(join(dataDir, 'STATUS.json'), 'utf8');
    expect(JSON.parse(text)).toEqual(STATUS);
    expect(text).toContain('\n  "health": "holding"');
    expect(readdirSync(dataDir)).toEqual(['STATUS.json']);
  });

  it('replaces the previous status', () => {
    const dataDir = tempDir();
    writeStatus(dataDir, STATUS);
    const next: StatusFile = {
      ...STATUS,
      tick: 43,
      health: 'halted',
      halted: true,
      holdReasons: {},
      lastTradeAtSec: null,
    };

    writeStatus(dataDir, next);

    expect(JSON.parse(readFileSync(join(dataDir, 'STATUS.json'), 'utf8'))).toEqual(next);
    expect(readdirSync(dataDir)).toEqual(['STATUS.json']);
  });

  it('creates the data directory', () => {
    const dataDir = join(tempDir(), 'nested', 'data');

    writeStatus(dataDir, STATUS);

    expect(JSON.parse(readFileSync(join(dataDir, 'STATUS.json'), 'utf8'))).toEqual(STATUS);
  });
});

describe('STOP file', () => {
  it('is absent until writeStopFile writes a timestamped reason line', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 9, 16, 12, 30, 0, 250) });
    const dataDir = tempDir();
    expect(stopFilePresent(dataDir)).toBe(false);

    writeStopFile(dataDir, 'receipt mismatch');

    expect(stopFilePresent(dataDir)).toBe(true);
    expect(readFileSync(join(dataDir, 'STOP'), 'utf8')).toBe('2026-10-16T12:30:00.250Z receipt mismatch\n');
  });

  it('appends a line when the file already exists', () => {
    const dataDir = tempDir();
    writeFileSync(join(dataDir, 'STOP'), 'by hand\n');

    writeStopFile(dataDir, 'gas echo mismatch');
    writeStopFile(dataDir, 'repeated confirm errors');

    const fileLines = readFileSync(join(dataDir, 'STOP'), 'utf8').split('\n');
    expect(fileLines).toHaveLength(4);
    expect(fileLines[0]).toBe('by hand');
    expect(fileLines[1]).toMatch(ISO_LINE);
    expect(fileLines[1]?.endsWith(' gas echo mismatch')).toBe(true);
    expect(fileLines[2]?.endsWith(' repeated confirm errors')).toBe(true);
    expect(fileLines[3]).toBe('');
  });

  it('creates the data directory', () => {
    const dataDir = join(tempDir(), 'nested', 'data');

    writeStopFile(dataDir, 'apr echo disagreement');

    expect(existsSync(join(dataDir, 'STOP'))).toBe(true);
    expect(stopFilePresent(dataDir)).toBe(true);
  });
});
