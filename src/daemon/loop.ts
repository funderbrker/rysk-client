import type { Side } from '../domain/types.ts';
import type { TradeIntent, TradeResult } from '../execution/types.ts';
import type { Clock, sleep } from '../lib/time.ts';
import type { WheelConfig } from '../strategy/wheel/config.ts';
import {
  checkGates,
  deriveState,
  evaluate,
  isBasisRelevant,
  pickSide,
  planSide,
} from '../strategy/wheel/index.ts';
import type {
  Candidate,
  Decision,
  HoldReason,
  QuotedCandidate,
  QuoteOutcome,
  Snapshot,
  WheelState,
} from '../strategy/wheel/types.ts';
import type { AppConfig } from './config.ts';
import { applyTradeResult, haltLive, resolveWaits } from './cooldown.ts';
import { type Log, redactRecord } from './logger.ts';
import type { Memo } from './memo.ts';
import type { Recorder, RecordStream } from './recorder.ts';
import {
  candidateKey,
  decisionRecord,
  intentSummary,
  quoteRecord,
  replanRecord,
  stateRecord,
} from './records.ts';
import type { StatusFile } from './status.ts';

export type LoopDeps = {
  /** One tick's snapshot (`gatherSnapshot`); a rejection holds the tick. */
  snapshot(): Promise<Snapshot>;
  /** One RFQ with its gas preview and maker-signature check; called serially, never concurrently. */
  quote(c: Candidate): Promise<QuoteOutcome>;
  /** `sellOption` in the run's mode. */
  execute(i: TradeIntent): Promise<TradeResult>;
  /** Read just before `execute`: an `unknown` result's evidence is a counter above it. */
  vaultCounter(): Promise<bigint>;
  recorder: Pick<Recorder, 'append'>;
  /** Writes `STATUS.json`. */
  status(s: StatusFile): void;
  /** Whether `data/STOP` exists (gate G10, and read again right before a live execution). */
  stopFile(): boolean;
  /** The frontend version tripwire (gate G10). */
  frontendChanged(): boolean;
  /** Writes `data/STOP` with the reason (a fatal event). */
  writeStop(reason: string): void;
  clock: Clock;
  log: Log;
  memo: Memo;
  signal: AbortSignal;
  sleep: typeof sleep;
};

type Hold = Extract<Decision, { kind: 'hold' }>;
type Trade = Extract<Decision, { kind: 'trade' }>;

/** What the loop keeps across ticks besides the memo. */
type Run = {
  tick: number;
  consecutiveFailures: number;
  /** Completed executions, for `--max-trades`: `filled` in live, `aborted('dry-run')` in dry-run. */
  completed: number;
  lastTradeAtSec: number | null;
  /** The `apr-floor` hold a side repeats while it waits for `replanDueSec`. */
  lastHold: Partial<Record<Side, Hold>>;
};

/** One tick's inputs, shared by its steps. */
type Tick = { deps: LoopDeps; config: AppConfig; c: WheelConfig; run: Run; st: WheelState; s: Snapshot };

const SIDES: readonly Side[] = ['put', 'call'];
/** The consecutive snapshot failure that is logged at error level (once per run of failures). */
const ESCALATE_AT_FAILURE = 3;
/** RFQ error text suggesting a geo or access block (spec §10). */
const GEO_BLOCKED = /geo|forbidden|restricted/i;
const HOUR_SEC = 3_600;

/**
 * The daemon loop (spec §9.1), at a fixed delay: a tick, then `tickSeconds` of sleep, so a slow trade never
 * overlaps a tick. Ends when `signal` aborts or after `config.maxTrades` completed executions; a failed snapshot,
 * RFQ or execution is logged and never ends it.
 *
 * A tick: snapshot → resolve the filled and unknown waits → `deriveState` → G3's run start → `STATUS.json` → a
 * `state` record → per side, unless it waits for `replanDueSec`: `planSide` on the full snapshot → its backed-off
 * candidates dropped (none left: an `apr-floor` hold, no RFQ) → each remaining one quoted in turn (a `quotes`
 * record each) → `evaluate` → a `decisions` record. An `apr-floor` hold backs off the keys it quoted and re-plans
 * after `replanSec`. Then `pickSide`'s trade, if any, is executed once: in live unless halted or STOP is present,
 * in dry-run always (STOP included), where an `aborted('dry-run')` records the simulated deployment (spec §8.8).
 */
export async function runLoop(deps: LoopDeps, config: AppConfig): Promise<void> {
  const run: Run = { tick: 0, consecutiveFailures: 0, completed: 0, lastTradeAtSec: null, lastHold: {} };
  while (!deps.signal.aborted) {
    run.tick += 1;
    let done = false;
    try {
      done = await tick(deps, config, run);
    } catch (error) {
      deps.log.error({ err: error, tick: run.tick }, 'tick failed; holding');
    }
    if (done) return;
    await deps.sleep(config.tickSeconds * 1000, deps.signal);
  }
}

/** One tick; true when `--max-trades` is reached. */
async function tick(deps: LoopDeps, config: AppConfig, run: Run): Promise<boolean> {
  const { memo } = deps;
  const c = config.wheel;
  memo.stopFile = deps.stopFile();
  memo.frontendChanged = deps.frontendChanged();
  let fetched: Snapshot;
  try {
    fetched = await deps.snapshot();
  } catch (error) {
    snapshotFailed(deps, c, run, error);
    return false;
  }
  run.consecutiveFailures = 0;
  if (deps.signal.aborted) return false;

  const io = { deps, config };
  resolveWaits(memo, fetched, c, { log: deps.log, record: (stream, r) => record(io, stream, r) });
  memo.forgetExpiredKeys(fetched.nowSec);
  const st = deriveState({ ...fetched, memo: memo.snapshotMemo() }, c);
  memo.observePendingSettlement(
    st.rows.some((row) => row.phase === 'pendingSettlement' && isBasisRelevant(row.cls)),
    fetched.nowSec,
  );
  warnOverdueSettlements(st, fetched, c, deps.log);
  const t: Tick = { deps, config, c, run, st, s: { ...fetched, memo: memo.snapshotMemo() } };

  writeStatus(deps, c, run, holdReasons(t));
  record(t, 'state', stateRecord(run.tick, st, t.s, memo));
  const trades: Trade[] = [];
  for (const side of SIDES) {
    if (deps.signal.aborted) return false;
    const decision = await decideSide(t, side);
    if (decision?.kind === 'trade') trades.push(decision);
  }
  return executePicked(t, trades);
}

/** Plans, quotes and evaluates one side, recording the decision; `null` while it waits to re-plan. */
async function decideSide(t: Tick, side: Side): Promise<Decision | null> {
  const { deps, c, run, st, s } = t;
  const { memo } = deps;
  const dueSec = memo.replanDueSec[side];
  if (dueSec !== undefined && s.nowSec < dueSec) {
    const held = run.lastHold[side] ?? { kind: 'hold', side, reason: 'apr-floor' };
    record(t, 'decisions', replanRecord(run.tick, side, s.nowSec, dueSec, held));
    return null;
  }
  delete memo.replanDueSec[side];

  const plan = planSide(side, st, s, c);
  if (plan.kind === 'hold') {
    const decision: Decision = { kind: 'hold', side, reason: plan.reason };
    const detail = plan.detail;
    record(t, 'decisions', decisionRecord(run.tick, plan, [], decision, { st, s, c, backedOff: [], detail }));
    return decision;
  }
  const { ready, backedOff } = withoutBackedOff(plan.candidates, s, memo);
  if (ready.length === 0) {
    // Every planned candidate is throttled: hold at the floor without an RFQ (re-planned next tick).
    const decision: Decision = { kind: 'hold', side, reason: 'apr-floor' };
    const detail = `every candidate is backed off: ${backedOff.join(', ')}`;
    record(t, 'decisions', decisionRecord(run.tick, plan, [], decision, { st, s, c, backedOff, detail }));
    return decision;
  }
  const quoted = await quoteEach(t, ready);
  const decision = evaluate(side, quoted, st, s, c);
  backOff(t, side, quoted, decision);
  record(t, 'decisions', decisionRecord(run.tick, plan, quoted, decision, { st, s, c, backedOff }));
  return decision;
}

/**
 * The planned candidates split into those to quote and the keys left out as backed off, after resetting any key
 * whose spot or indicative APR moved enough. `planSide` sees the full snapshot, so the backoff never changes what
 * it plans (normal or fallback, and which fallback strike); it only throttles the RFQs.
 */
function withoutBackedOff(
  candidates: Candidate[],
  s: Snapshot,
  memo: Memo,
): { ready: Candidate[]; backedOff: string[] } {
  const backedOff: string[] = [];
  const ready = candidates.filter((candidate) => {
    if (candidate.indicativeApr === null) return true;
    const key = candidateKey(candidate);
    memo.resetBackoffIf(key, s.market.spotE8, candidate.indicativeApr);
    if (!memo.isBackedOff(key, s.nowSec)) return true;
    backedOff.push(key);
    return false;
  });
  return { ready, backedOff };
}

/**
 * Quotes the candidates one at a time, recording each RFQ. An RFQ error suggesting a geo block halts live (once:
 * a halted live never executes again); dry-run logs it and keeps quoting.
 */
async function quoteEach(t: Tick, candidates: Candidate[]): Promise<QuotedCandidate[]> {
  const { deps, c, run, s } = t;
  const quoted: QuotedCandidate[] = [];
  for (const candidate of candidates) {
    if (deps.signal.aborted) break;
    const outcome = await requestQuote(deps, candidate);
    quoted.push({ candidate, outcome });
    record(t, 'quotes', quoteRecord(run.tick, candidate, outcome, s));
    if (!outcome.ok && GEO_BLOCKED.test(outcome.message) && !deps.memo.haltedLive) {
      haltLive(deps.memo, `RFQ refused: ${outcome.message}`, c, deps);
    }
  }
  return quoted;
}

/** `deps.quote`, with a throw turned into an `rpc-error` outcome. */
async function requestQuote(deps: LoopDeps, candidate: Candidate): Promise<QuoteOutcome> {
  const requestedAtMs = deps.clock.nowMs();
  try {
    return await deps.quote(candidate);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: 'rpc-error', message, requestedAtMs };
  }
}

/**
 * Key backoff (spec §8.7, §10) for the listed candidates (a custom strike has no listing and is left to
 * `replanSec`): one whose RFQ failed on its own (anything but a closed socket) or whose gas preview failed, and,
 * when the side held, every one that was answered (none cleared the floor). An `apr-floor` hold also schedules
 * the side's re-plan.
 */
function backOff(t: Tick, side: Side, quoted: QuotedCandidate[], decision: Decision): void {
  const { deps, c, run, s } = t;
  const { memo } = deps;
  for (const { candidate, outcome } of quoted) {
    const apr = candidate.indicativeApr;
    if (apr === null) continue;
    const failed = outcome.ok ? !outcome.gas.ok : outcome.error !== 'socket-closed';
    if (failed || (outcome.ok && decision.kind === 'hold')) {
      memo.backoffKey(candidateKey(candidate), s.nowSec, s.market.spotE8, apr);
    }
  }
  if (decision.kind === 'hold' && decision.reason === 'apr-floor') {
    memo.replanDueSec[side] = s.nowSec + c.quoting.replanSec;
    run.lastHold[side] = decision;
  }
}

/** Executes `pickSide`'s trade at most once; true when `--max-trades` is reached. */
async function executePicked(t: Tick, trades: Trade[]): Promise<boolean> {
  const { deps, config, c, run, s } = t;
  const { memo } = deps;
  const picked = pickSide(trades, c);
  if (picked === null || picked.kind !== 'trade') return false;
  const { side } = picked.candidate;
  if (c.mode === 'live' && (memo.haltedLive || deps.stopFile())) {
    deps.log.warn({ side, haltedLive: memo.haltedLive }, 'not executing: live is halted or STOP is present');
    return false;
  }
  if (deps.signal.aborted) return false;

  const intent: TradeIntent = {
    side,
    candidate: picked.candidate,
    quote: picked.quote,
    minPriceE18: picked.minPriceE18,
    maxGasFee6: picked.maxGasFee6,
  };
  const counterBefore = await vaultCounterBefore(deps, s);
  const { result, thrown } = await executeOnce(deps, intent, s);
  const nowSec = chainNowSec(s, deps.clock);
  const failure = thrown === undefined ? {} : { thrown };
  const summary = intentSummary(intent);
  record(t, 'executions', { tick: run.tick, step: 'result', side, intent: summary, result, ...failure });

  const { strikeE8, expirySec, quantityE18 } = picked.candidate;
  const terms = { isPut: side === 'put', strikeE8, expirySec, quantityE18 };
  applyTradeResult(memo, side, result, nowSec, c, {
    terms,
    counterBefore,
    writeStop: (reason) => deps.writeStop(reason),
    log: deps.log,
  });
  const simulated = c.mode === 'dry-run' && result.status === 'aborted' && result.stage === 'dry-run';
  if (simulated) memo.simulatedDeploySec[side] = nowSec;
  if (simulated || (c.mode === 'live' && result.status === 'filled')) {
    run.completed += 1;
    run.lastTradeAtSec = nowSec;
  }
  return config.maxTrades !== undefined && run.completed >= config.maxTrades;
}

/**
 * `deps.execute` with `memo.inFlight` set around it. `sellOption` is designed never to throw; should anything
 * throw anyway, the confirm may have been sent, so the outcome is treated as `unknown` (the side holds).
 */
async function executeOnce(
  deps: LoopDeps,
  intent: TradeIntent,
  s: Snapshot,
): Promise<{ result: TradeResult; thrown?: string }> {
  deps.memo.inFlight = true;
  try {
    return { result: await deps.execute(intent) };
  } catch (error) {
    deps.log.error({ err: error, side: intent.side }, 'execute threw: treating the outcome as unknown');
    const thrown = error instanceof Error ? error.message : String(error);
    const result: TradeResult = {
      status: 'unknown',
      reason: 'bad-result',
      confirmSentAtSec: s.nowSec,
      bookkeepingErrors: [],
    };
    return { result, thrown };
  } finally {
    deps.memo.inFlight = false;
  }
}

/** The vault counter now, or the snapshot's when the read fails (a lower base only resolves a wait sooner). */
async function vaultCounterBefore(deps: LoopDeps, s: Snapshot): Promise<bigint> {
  try {
    return await deps.vaultCounter();
  } catch (error) {
    deps.log.warn({ err: error }, "vault counter read failed: using the snapshot's");
    return s.chain.vaultCounter;
  }
}

/** Chain time now: the snapshot's block time advanced by the process time since it was taken. */
function chainNowSec(s: Snapshot, clock: Clock): number {
  return s.nowSec + Math.max(0, Math.floor((clock.nowMs() - s.localNowMs) / 1000));
}

/** Each side's hold as STATUS.json shows it: the repeated `apr-floor` while waiting to re-plan, else its gates'. */
function holdReasons(t: Tick): Partial<Record<Side, HoldReason>> {
  const { deps, c, run, st, s } = t;
  const reasons: Partial<Record<Side, HoldReason>> = {};
  for (const side of SIDES) {
    const dueSec = deps.memo.replanDueSec[side];
    const waiting = dueSec !== undefined && s.nowSec < dueSec;
    const hold = waiting ? (run.lastHold[side]?.reason ?? 'apr-floor') : checkGates(side, st, s, c).hold;
    if (hold !== null) reasons[side] = hold;
  }
  return reasons;
}

/** Warns about every row still awaiting settlement `settlementOverdueHours` after its expiry (G3 holds). */
function warnOverdueSettlements(st: WheelState, s: Snapshot, c: WheelConfig, log: Log): void {
  const overdueSec = c.safety.settlementOverdueHours * HOUR_SEC;
  for (const { position, phase } of st.rows) {
    if (phase === 'pendingSettlement' && s.nowSec - position.expirySec > overdueSec) {
      log.warn({ key: position.key, expirySec: position.expirySec, overdueSec }, 'settlement overdue');
    }
  }
}

/** A failed snapshot holds the tick: a warning each time, an error at the third in a row. */
function snapshotFailed(deps: LoopDeps, c: WheelConfig, run: Run, error: unknown): void {
  run.consecutiveFailures += 1;
  const detail = { err: error, consecutiveFailures: run.consecutiveFailures };
  deps.log.warn(detail, 'snapshot failed: holding the tick');
  if (run.consecutiveFailures === ESCALATE_AT_FAILURE) {
    deps.log.error(detail, 'snapshot failed three ticks in a row');
  }
  writeStatus(deps, c, run, { put: 'stale-data', call: 'stale-data' });
}

function writeStatus(
  deps: LoopDeps,
  c: WheelConfig,
  run: Run,
  holds: Partial<Record<Side, HoldReason>>,
): void {
  const halted = c.mode === 'live' && deps.memo.haltedLive;
  const holding = Object.keys(holds).length > 0;
  try {
    deps.status({
      tsMs: deps.clock.nowMs(),
      health: halted ? 'halted' : holding ? 'holding' : 'ok',
      holdReasons: holds,
      halted,
      lastTradeAtSec: run.lastTradeAtSec,
      tick: run.tick,
      mode: c.mode,
    });
  } catch (error) {
    deps.log.error({ err: error }, 'could not write STATUS.json');
  }
}

/** Appends a record with the RPC URL redacted from its text; a failed write is logged and never stops the tick. */
function record(t: { deps: LoopDeps; config: AppConfig }, stream: RecordStream, body: object): void {
  const { deps, config } = t;
  try {
    deps.recorder.append(stream, redactRecord(body, config.rpcUrl));
  } catch (error) {
    deps.log.error({ err: error, stream }, 'could not append a record');
  }
}
