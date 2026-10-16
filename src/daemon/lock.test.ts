import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireLock, LockHeldError } from './lock.ts';

// Not a running process (asserted where used).
const DEAD_PID = 999_999;

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rysk-lock-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function lockError(acquire: () => unknown): LockHeldError {
  try {
    acquire();
  } catch (error) {
    if (error instanceof LockHeldError) return error;
    throw error;
  }
  throw new Error('expected a LockHeldError');
}

function lockRecord(dataDir: string): unknown {
  return JSON.parse(readFileSync(join(dataDir, 'live.lock'), 'utf8'));
}

describe('acquireLock', () => {
  it('creates live.lock holding our pid and start time', () => {
    const dataDir = tempDir();
    const before = Date.now();

    acquireLock(dataDir);

    const record = lockRecord(dataDir) as { pid: number; startedAtMs: number };
    expect(record.pid).toBe(process.pid);
    expect(record.startedAtMs).toBeGreaterThanOrEqual(before);
    expect(record.startedAtMs).toBeLessThanOrEqual(Date.now());
  });

  it('creates the data directory', () => {
    const dataDir = join(tempDir(), 'nested', 'data');

    acquireLock(dataDir);

    expect(existsSync(join(dataDir, 'live.lock'))).toBe(true);
  });

  it('refuses a second lock while the first holder (this process) is alive', () => {
    const dataDir = tempDir();
    acquireLock(dataDir);

    const error = lockError(() => acquireLock(dataDir));

    expect(error.pid).toBe(process.pid);
    expect(error.message).toContain(String(process.pid));
  });

  it('refuses a lock held by another live process and leaves it in place', () => {
    const dataDir = tempDir();
    // pid 1 exists in every pid namespace; `kill(1, 0)` succeeds as root and fails with EPERM otherwise.
    const theirs = JSON.stringify({ pid: 1, startedAtMs: 0 });
    writeFileSync(join(dataDir, 'live.lock'), theirs);

    expect(lockError(() => acquireLock(dataDir)).pid).toBe(1);
    expect(readFileSync(join(dataDir, 'live.lock'), 'utf8')).toBe(theirs);
  });

  it('takes over a lock whose holder is no longer running', () => {
    expect(() => process.kill(DEAD_PID, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    const dataDir = tempDir();
    writeFileSync(join(dataDir, 'live.lock'), JSON.stringify({ pid: DEAD_PID, startedAtMs: 0 }));

    acquireLock(dataDir);

    expect(lockRecord(dataDir)).toMatchObject({ pid: process.pid });
  });

  it.each([
    ['empty', ''],
    ['not JSON', 'garbage'],
    ['no pid', '{"startedAtMs":0}'],
    ['a string pid', '{"pid":"999999"}'],
    ['pid 0', '{"pid":0}'],
    ['a negative pid', '{"pid":-1}'],
    ['a fractional pid', '{"pid":1.5}'],
    ['an array', '[999999]'],
  ])('fails closed on an unreadable lock file (%s) and leaves it in place', (_name, text) => {
    const dataDir = tempDir();
    writeFileSync(join(dataDir, 'live.lock'), text);

    const error = lockError(() => acquireLock(dataDir));

    expect(error.pid).toBeNull();
    expect(readFileSync(join(dataDir, 'live.lock'), 'utf8')).toBe(text);
  });
});

describe('Lock.release', () => {
  it('is held from acquire until release, and stays released', () => {
    const lock = acquireLock(tempDir());
    expect(lock.held).toBe(true);

    lock.release();
    expect(lock.held).toBe(false);
    lock.release();
    expect(lock.held).toBe(false);
  });

  it('removes the lock file so the lock can be acquired again', () => {
    const dataDir = tempDir();
    const lock = acquireLock(dataDir);

    lock.release();

    expect(existsSync(join(dataDir, 'live.lock'))).toBe(false);
    acquireLock(dataDir);
    expect(lockRecord(dataDir)).toMatchObject({ pid: process.pid });
  });

  it('leaves a lock file that another instance now holds', () => {
    const dataDir = tempDir();
    const lock = acquireLock(dataDir);
    const theirs = JSON.stringify({ pid: DEAD_PID, startedAtMs: 0 });
    writeFileSync(join(dataDir, 'live.lock'), theirs);

    lock.release();

    expect(readFileSync(join(dataDir, 'live.lock'), 'utf8')).toBe(theirs);
  });

  it('leaves a later lock taken by this process after the first was released', () => {
    // A frozen clock makes both locks' records identical, so only the released handle's own state protects.
    vi.useFakeTimers({ toFake: ['Date'], now: 1_792_195_200_000 });
    const dataDir = tempDir();
    const first = acquireLock(dataDir);
    first.release();
    acquireLock(dataDir);

    first.release();

    expect(lockRecord(dataDir)).toMatchObject({ pid: process.pid });
  });

  it('does nothing when the lock file is already gone', () => {
    const dataDir = tempDir();
    const lock = acquireLock(dataDir);
    rmSync(join(dataDir, 'live.lock'));

    expect(() => lock.release()).not.toThrow();
  });
});
