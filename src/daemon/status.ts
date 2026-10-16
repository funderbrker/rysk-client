import { appendFileSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Side } from '../domain/types.ts';
import { stringifyBig } from '../lib/json.ts';
import type { HoldReason } from '../strategy/wheel/types.ts';

/** `<dataDir>/STATUS.json`, rewritten each tick and after each execution (spec §9.4). */
export type StatusFile = {
  tsMs: number;
  health: 'ok' | 'holding' | 'halted';
  holdReasons: Partial<Record<Side, HoldReason>>;
  halted: boolean;
  /** Chain seconds at the end of the last completed execution (see `completed`); `null` before the first. */
  lastTradeAtSec: number | null;
  /** The `--max-trades` count: live results whose confirm was sent, or dry-run's simulated deployments. */
  completed: number;
  tick: number;
  mode: 'live' | 'dry-run';
  /** The frontend version tripwire's latest `sha`; `null` while it is inactive (no version check succeeded). */
  frontendSha: string | null;
  /** Whether the frontend `sha` changed since startup (gate G10 with `pauseOnFrontendChange`). */
  frontendChanged: boolean;
};

const STATUS_FILE = 'STATUS.json';
const STOP_FILE = 'STOP';
/** The longest reason a STOP line keeps: RFQ error text, which the server controls, can reach it. */
const MAX_STOP_REASON_CHARS = 500;

/**
 * Writes `<dataDir>/STATUS.json` atomically: the JSON (2-space indent) goes to `STATUS.json.tmp`, which is then
 * renamed over the old file, so a reader sees the previous status or the new one, never a partial file.
 */
export function writeStatus(dataDir: string, status: StatusFile): void {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, STATUS_FILE);
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${stringifyBig(status, 2)}\n`);
  renameSync(temp, path);
}

/**
 * Whether `<dataDir>/STOP` exists: the kill switch (spec §9.4). It fails closed: a path that cannot be checked (any
 * error but the entry being absent, such as a permission or I/O error) counts as present, so live holds.
 */
export function stopFilePresent(dataDir: string): boolean {
  try {
    return statSync(join(dataDir, STOP_FILE), { throwIfNoEntry: false }) !== undefined;
  } catch {
    return true;
  }
}

/**
 * Appends `<ISO timestamp> <reason>` as a line to `<dataDir>/STOP`, creating the file (and `dataDir`) if needed.
 * The reason is kept to one line (runs of whitespace, newlines included, become one space) of at most 500
 * characters. An existing file is kept and appended to, never an error.
 */
export function writeStopFile(dataDir: string, reason: string): void {
  mkdirSync(dataDir, { recursive: true });
  const line = reason.replace(/\s+/g, ' ').trim().slice(0, MAX_STOP_REASON_CHARS);
  appendFileSync(join(dataDir, STOP_FILE), `${new Date().toISOString()} ${line}\n`);
}
