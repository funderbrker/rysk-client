import { appendFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Side } from '../domain/types.ts';
import { stringifyBig } from '../lib/json.ts';
import type { HoldReason } from '../strategy/wheel/types.ts';

/** `<dataDir>/STATUS.json`, rewritten each tick (spec §9.4). */
export type StatusFile = {
  tsMs: number;
  health: 'ok' | 'holding' | 'halted';
  holdReasons: Partial<Record<Side, HoldReason>>;
  halted: boolean;
  lastTradeAtSec: number | null;
  tick: number;
  mode: 'live' | 'dry-run';
};

const STATUS_FILE = 'STATUS.json';
const STOP_FILE = 'STOP';

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

/** Whether `<dataDir>/STOP` exists: the kill switch (spec §9.4). */
export function stopFilePresent(dataDir: string): boolean {
  return existsSync(join(dataDir, STOP_FILE));
}

/**
 * Appends `<ISO timestamp> <reason>` as a line to `<dataDir>/STOP`, creating the file (and `dataDir`) if needed.
 * An existing file is kept and appended to, never an error.
 */
export function writeStopFile(dataDir: string, reason: string): void {
  mkdirSync(dataDir, { recursive: true });
  appendFileSync(join(dataDir, STOP_FILE), `${new Date().toISOString()} ${reason}\n`);
}
