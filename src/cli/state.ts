import { type AppConfig, createLogger, stateRecord, wireDaemon } from '../daemon/index.ts';
import type { Side } from '../domain/types.ts';
import { stringifyBig } from '../lib/json.ts';
import { checkGates, deriveState } from '../strategy/wheel/index.ts';
import type { StateCommand } from './args.ts';

const SIDES: readonly Side[] = ['put', 'call'];

/**
 * `rysk state`: one snapshot through the daemon's own wiring (dry-run, no keystore), its derived state as the
 * `state` record writes it, and each side's gates. It is what the daemon's first tick sees, so gate G3 holds until
 * a tick has seen no pending settlement (a fresh process has none recorded). Parser warnings go to stderr.
 */
export async function stateCommand(_cmd: StateCommand, config: AppConfig): Promise<number> {
  const log = createLogger({ level: 'warn', rpcUrl: config.rpcUrl, destination: process.stderr });
  const wired = wireDaemon(config, { account: null, log, signal: new AbortController().signal });
  const { memo } = wired.loopDeps;
  const s = await wired.loopDeps.snapshot();
  const st = deriveState(s, config.wheel);
  const gates = Object.fromEntries(SIDES.map((side) => [side, checkGates(side, st, s, config.wheel)]));
  const { tick: _tick, ...state } = stateRecord(0, st, s, memo) as Record<string, unknown>;
  process.stdout.write(`${stringifyBig({ mode: s.mode, ...state, gates }, 2)}\n`);
  return 0;
}
