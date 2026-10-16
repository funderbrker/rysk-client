import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOCK_FILE = 'live.lock';

/** A `live.lock` this process took: `held` until `release()`. */
export type Lock = { readonly held: boolean; release(): void };

/**
 * `live.lock` is held by another instance: a running process (`pid`), or a lock file whose content cannot be read
 * as one (`pid` null), which is never taken over and must be removed by hand once no instance is running.
 */
export class LockHeldError extends Error {
  readonly path: string;
  readonly pid: number | null;

  constructor(path: string, pid: number | null) {
    super(
      pid === null
        ? `${path} exists but holds no valid pid; remove it by hand if no live instance is running`
        : `${path} is held by running process ${pid}`,
    );
    this.name = 'LockHeldError';
    this.path = path;
    this.pid = pid;
  }
}

/**
 * Takes `<dataDir>/live.lock`, the one-live-instance-per-host lock (spec §7): created exclusively (`O_EXCL`)
 * with `{ pid, startedAtMs }` inside. When the file exists and its pid is no longer running, it is removed and
 * the create retried once; a running holder (this process included) or an unreadable file throws
 * `LockHeldError`. `release()` removes the file only while it still holds this lock's own record, so another
 * instance's lock is never removed; it is idempotent, and `held` is false from then on.
 */
export function acquireLock(dataDir: string): Lock {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, LOCK_FILE);
  const record = JSON.stringify({ pid: process.pid, startedAtMs: Date.now() });
  if (!created(path, record)) {
    const pid = recordedPid(path);
    if (pid === null || (pid !== undefined && isRunning(pid))) throw new LockHeldError(path, pid);
    if (pid !== undefined) rmSync(path, { force: true });
    if (!created(path, record)) throw new LockHeldError(path, recordedPid(path) ?? null);
  }
  let released = false;
  return {
    get held() {
      return !released;
    },
    release() {
      if (released) return;
      released = true;
      if (contentOf(path) === record) rmSync(path, { force: true });
    },
  };
}

/** Creates `path` holding `record` unless it already exists; false when it does. */
function created(path: string, record: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx');
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false;
    throw error;
  }
  try {
    writeFileSync(fd, record);
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  } finally {
    closeSync(fd);
  }
  return true;
}

/** The file's text, or undefined when it does not exist. */
function contentOf(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

/** The lock file's pid: a positive integer, null when the content is not a valid record, undefined when gone. */
function recordedPid(path: string): number | null | undefined {
  const text = contentOf(path);
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const pid = typeof parsed === 'object' && parsed !== null ? (parsed as { pid?: unknown }).pid : undefined;
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/** Whether `pid` is running: signal 0 checks without signalling. Only ESRCH means gone; EPERM means alive. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== 'ESRCH';
  }
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
}
