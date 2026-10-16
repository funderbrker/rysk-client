import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { stringifyBig } from '../lib/json.ts';
import type { Clock } from '../lib/time.ts';

/** The JSONL streams under `<dataDir>/<stream>/` (spec §9.3). */
export type RecordStream = 'quotes' | 'decisions' | 'executions' | 'inventory' | 'public-fills' | 'state';

/** The run-wide fields written on every record. */
export type RecorderEnvelope = {
  runId: string;
  mode: 'live' | 'dry-run';
  codeRev: string;
  configHash: string;
};

export type RecorderOptions = { dataDir: string; envelope: RecorderEnvelope; clock: Clock };

/**
 * Append-only JSONL research and audit records (spec §9.3). Each `append` writes one line to
 * `<dataDir>/<stream>/<YYYY-MM-DD>.jsonl` (the UTC day of `clock.nowMs()`) with `appendFileSync`, so no handle
 * stays open and a crash loses at most the line being written. The line is the record plus the envelope
 * `{ v: 1, kind: stream, tsMs, runId, mode, codeRev, configHash }`, whose fields win over record keys of the
 * same name; every bigint is written as its decimal string. A failed write throws: the caller decides.
 */
export class Recorder {
  readonly #dataDir: string;
  readonly #envelope: RecorderEnvelope;
  readonly #clock: Clock;

  constructor(opts: RecorderOptions) {
    this.#dataDir = opts.dataDir;
    this.#envelope = opts.envelope;
    this.#clock = opts.clock;
  }

  append(stream: RecordStream, record: object): void {
    const tsMs = this.#clock.nowMs();
    const line = stringifyBig({ ...record, v: 1, kind: stream, tsMs, ...this.#envelope });
    const dir = join(this.#dataDir, stream);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `${utcDay(tsMs)}.jsonl`), `${line}\n`);
  }
}

/** `YYYY-MM-DD` of `ms` in UTC. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
