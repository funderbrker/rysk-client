import { readFileSync } from 'node:fs';
import type { Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ConfigPatch,
  fixtureAssets,
  fixtureCaps,
  fixtureListings,
  fixturePositions,
  NOW_SEC,
  snapshotFromFixtures,
  wheelConfig,
} from '../../test/helpers/wheelSnapshot.ts';
import type { Position, Quote, Side } from '../domain/types.ts';
import type { TradeIntent, TradeResult } from '../execution/types.ts';
import { sleep } from '../lib/time.ts';
import type { Candidate, QuoteOutcome, Snapshot } from '../strategy/wheel/types.ts';
import type { AppConfig } from './config.ts';
import { type LoopDeps, runLoop } from './loop.ts';
import { Memo } from './memo.ts';
import type { RecordStream } from './recorder.ts';
import type { StatusFile } from './status.ts';

type SpikeRequest = { reply: { result: Quote } };
const capture = JSON.parse(
  readFileSync(new URL('../../test/fixtures/spike-capture.json', import.meta.url), 'utf8'),
) as { requests: [SpikeRequest, SpikeRequest, ...SpikeRequest[]] };
const [putSpike, callSpike] = capture.requests;

const DAY_SEC = 86_400;
const TICK_MS = 60_000;
const SPOT_E8 = 8148032044n;
/** 1.5 USD a contract: about 98 % net APR on the 80.5 put a week out. */
const PUT_PRICE_E18 = 1_500000000000000000n;
/** 0.05 USD a contract: about 3 % net APR on a call, below the 10 % floor. */
const CALL_PRICE_E18 = 50000000000000000n;
const GAS6 = 10_000n;
const TX: Hex = `0x${'ab'.repeat(32)}`;
const DRY_RUN: TradeResult = {
  status: 'aborted',
  stage: 'dry-run',
  message: 'dry-run: every check passed',
  echoOk: true,
  wouldApprove: 0n,
};

type Mode = 'live' | 'dry-run';
type Rec = Record<string, unknown> & { tick?: number; side?: string };

/** The fixture rows with the open put deployed two days back, so the put's 24 h interval has passed. */
function happyPositions(): Position[] {
  return fixturePositions().map((p) =>
    p.isPut && p.status === 'open' ? { ...p, createdAtSec: NOW_SEC - 2 * DAY_SEC } : p,
  );
}

/** The fixture wallet as a tick taken at `nowMs` sees it: every gate passes on both sides. */
function fixtureTick(nowMs: number, mode: Mode, positions = happyPositions()): Snapshot {
  const nowSec = Math.floor(nowMs / 1000);
  return snapshotFromFixtures({
    nowSec,
    localNowMs: nowMs,
    mode,
    positions,
    chain: { blockTs: nowSec },
    market: {
      assets: fixtureAssets(),
      listings: fixtureListings(),
      caps: fixtureCaps(),
      spotE8: SPOT_E8,
      inventoryTs: nowSec,
    },
  });
}

/** A good quote for the candidate: well above the floor for puts, below it for calls. */
function goodQuote(c: Candidate, nowMs: number): QuoteOutcome {
  const spike = c.side === 'put' ? putSpike.reply.result : callSpike.reply.result;
  const price = c.side === 'put' ? PUT_PRICE_E18 : CALL_PRICE_E18;
  return {
    ok: true,
    quote: {
      ...spike,
      strike: c.request.strike,
      expiry: c.expirySec,
      quantity: c.request.quantity,
      price: price.toString(),
      validUntil: Math.floor(nowMs / 1000) + 60,
    },
    requestedAtMs: nowMs,
    respondedAtMs: nowMs + 250,
    makerSigOk: true,
    gas: { ok: true, gasFee6: GAS6 },
  };
}

/** The fixture's expiries 6.9 and 13.9 days out. */
const E1 = 1792742400;
const E2 = 1793347200;

function keyOf(side: Side, strikeE8: bigint, expirySec: number): string {
  return `${side}|${strikeE8}|${expirySec}`;
}

/** The indicative APR of a fixture listing, so a seeded backoff does not reset on it. */
function listingApr(side: Side, strikeE8: bigint, expirySec: number): number {
  const listing = fixtureListings().find(
    (l) => l.isPut === (side === 'put') && l.strikeE8 === strikeE8 && l.expirySec === expirySec,
  );
  if (listing === undefined) throw new Error(`no fixture listing ${keyOf(side, strikeE8, expirySec)}`);
  return listing.indicativeApr;
}

/** The keys a decision record planned and the ones it left out as backed off. */
function planned(d: Rec | undefined): string[] {
  return ((d?.candidates as { key: string }[] | undefined) ?? []).map((c) => c.key);
}

function backedOff(d: Rec | undefined): string[] {
  return [...((d?.backedOff as string[] | undefined) ?? [])];
}

function appConfig(mode: Mode, patch: Partial<AppConfig> = {}, wheel: ConfigPatch = {}): AppConfig {
  const minApr = { minApr: 0.1 };
  return {
    mode,
    account: { address: wheelConfig().self, keystorePath: 'keystore/wheel' },
    rpcUrl: 'http://127.0.0.1:8545',
    rysk: { restUrl: 'http://127.0.0.1:1', wsUrl: 'ws://127.0.0.1:1', appUrl: 'http://127.0.0.1:1' },
    tickSeconds: 60,
    dataDir: 'data',
    logLevel: 'info',
    wheel: wheelConfig({ mode, put: minApr, call: minApr, ...wheel }),
    sampler: {
      enabled: false,
      sweepEveryMin: 60,
      pinned: 4,
      pinnedEveryMin: 5,
      takerPairEveryMin: 60,
      inventoryEveryMin: 5,
      publicFillsEveryMin: 60,
      requestTimeoutMs: 6000,
      putStables: [],
      callCollaterals: [],
    },
    warnings: [],
    ...patch,
  };
}

function harness(mode: Mode, patch: Partial<LoopDeps> = {}) {
  const controller = new AbortController();
  const records: { stream: RecordStream; record: Rec }[] = [];
  const clock = { nowMs: () => Date.now() };
  const memo = new Memo(NOW_SEC * 1000 - 3_600_000);
  // An hour up with no settlement pending: G3's grace and G7's quiet period have passed.
  memo.lastNoPendingSeenSec = NOW_SEC - 3600;
  memo.uptimeSec = 3600;
  const deps: LoopDeps = {
    snapshot: vi.fn(async () => fixtureTick(clock.nowMs(), mode)),
    quote: vi.fn(async (c: Candidate) => goodQuote(c, clock.nowMs())),
    execute: vi.fn(async (_: TradeIntent): Promise<TradeResult> => DRY_RUN),
    vaultCounter: vi.fn(async () => 87n),
    recorder: {
      append: vi.fn(
        (stream: RecordStream, record: object) => void records.push({ stream, record: record as Rec }),
      ),
    },
    status: vi.fn<(s: StatusFile) => void>(),
    stopFile: vi.fn(() => false),
    frontendChanged: vi.fn(() => false),
    writeStop: vi.fn(),
    clock,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
    memo,
    signal: controller.signal,
    sleep,
    ...patch,
  };
  const of = (stream: RecordStream): Rec[] =>
    records.filter((entry) => entry.stream === stream).map((entry) => entry.record);
  return { deps, controller, memo, of };
}

/** Runs the loop for `ticks` ticks (one every 60 s of fake time), then aborts it and waits for it to end. */
async function runTicks(h: ReturnType<typeof harness>, config: AppConfig, ticks: number): Promise<void> {
  const done = runLoop(h.deps, config);
  await vi.advanceTimersByTimeAsync((ticks - 1) * TICK_MS);
  h.controller.abort();
  await done;
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW_SEC * 1000 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runLoop: dry-run', () => {
  it('records state, both decisions and the quotes, simulates the deployment and holds the interval after', async () => {
    const h = harness('dry-run');
    await runTicks(h, appConfig('dry-run'), 2);

    expect(h.deps.snapshot).toHaveBeenCalledTimes(2);
    expect(h.of('state').map((r) => r.tick)).toEqual([1, 2]);
    const decisions = h.of('decisions');
    expect(decisions.filter((d) => d.tick === 1).map((d) => d.side)).toEqual(['put', 'call']);
    expect(decisions.filter((d) => d.tick === 2).map((d) => d.side)).toEqual(['put', 'call']);

    // Three diversified candidates a side in tick 1, quoted one at a time; none in tick 2.
    expect(h.deps.quote).toHaveBeenCalledTimes(6);
    const quotes = h.of('quotes');
    expect(quotes).toHaveLength(6);
    expect(quotes[0]).toMatchObject({
      tick: 1,
      side: 'put',
      purpose: 'candidate',
      takerKind: 'self',
      outcome: 'quote',
      makerSigOk: true,
    });
    const [firstPut] = quotes;
    for (const field of ['aprGross', 'aprNet', 'aprGrossOverIndicative', 'aprNetOverIndicative']) {
      expect(typeof firstPut?.[field]).toBe('number');
    }
    // Valid 60 s past the tick's second, answered 250 ms in: 59.75 s left on the server clock.
    expect(firstPut?.quote).toMatchObject({ ttlSec: 59.75 });

    // The put trades (the call's quotes are below the floor); dry-run executes it and gets aborted('dry-run').
    expect(h.deps.execute).toHaveBeenCalledOnce();
    const [intent] = vi.mocked(h.deps.execute).mock.calls[0] ?? [];
    expect(intent?.side).toBe('put');
    const executions = h.of('executions');
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({ step: 'result', side: 'put', result: { stage: 'dry-run' } });
    expect(h.memo.simulatedDeploySec).toEqual({ put: NOW_SEC });

    const put2 = decisions.find((d) => d.tick === 2 && d.side === 'put');
    expect(put2?.result).toMatchObject({ kind: 'hold', reason: 'interval' });
    // The call held at the floor and waits `replanSec` (300 s) with no RFQs, recording the hold it repeats.
    const call1 = decisions.find((d) => d.tick === 1 && d.side === 'call');
    expect(call1?.result).toMatchObject({ kind: 'hold', reason: 'apr-floor' });
    const call2 = decisions.find((d) => d.tick === 2 && d.side === 'call');
    expect(call2).toMatchObject({
      replanDueSec: NOW_SEC + 300,
      result: { kind: 'hold', reason: 'apr-floor' },
    });
    expect(h.memo.keyBackoff.size).toBe(3);

    expect(h.deps.status).toHaveBeenCalledTimes(2);
    const status = vi.mocked(h.deps.status).mock.calls[1]?.[0];
    expect(status).toMatchObject({
      health: 'holding',
      holdReasons: { put: 'interval', call: 'apr-floor' },
      halted: false,
      lastTradeAtSec: NOW_SEC,
      tick: 2,
      mode: 'dry-run',
    });
  });

  it('holds a re-planned side at the floor without RFQs while every candidate it plans is backed off', async () => {
    const h = harness('dry-run');
    // Re-plan after 60 s, while the keys quoted below the floor are still backed off (300 s).
    await runTicks(h, appConfig('dry-run', {}, { quoting: { ...wheelConfig().quoting, replanSec: 60 } }), 2);

    const callQuotes = h.of('quotes').filter((q) => q.side === 'call');
    const keysOf = (tick: number) =>
      callQuotes.filter((q) => q.tick === tick).map((q) => (q.instrument as { key: string }).key);
    expect(keysOf(1)).toHaveLength(3);
    expect(keysOf(2)).toEqual([]);
    const call2 = h.of('decisions').find((d) => d.tick === 2 && d.side === 'call');
    // `planSide` saw every listing and planned the same three; all three are backed off.
    expect(planned(call2).sort()).toEqual([...keysOf(1)].sort());
    expect(backedOff(call2).sort()).toEqual([...keysOf(1)].sort());
    expect(call2?.result).toMatchObject({
      kind: 'hold',
      reason: 'apr-floor',
      detail: expect.stringContaining(keysOf(1)[0] ?? 'missing'),
    });
  });

  it('quotes the candidates not backed off, after resetting a key whose spot moved', async () => {
    const h = harness('dry-run');
    // The put plan's three: 80.5 and 78.5 a week out, 80 two weeks out (the candidates tests' fixture tick).
    const [top, second, third] = [
      ['put', 8050000000n, E1],
      ['put', 8000000000n, E2],
      ['put', 7850000000n, E1],
    ] as const;
    h.memo.backoffKey(keyOf(...top), NOW_SEC, SPOT_E8, listingApr(...top));
    // Backed off at a spot 10 % lower: the 2 % move resets it.
    h.memo.backoffKey(keyOf(...second), NOW_SEC, (SPOT_E8 * 9n) / 10n, listingApr(...second));
    await runTicks(h, appConfig('dry-run'), 1);

    const putKeys = h
      .of('quotes')
      .filter((q) => q.side === 'put')
      .map((q) => (q.instrument as { key: string }).key);
    expect(putKeys).toEqual([keyOf(...second), keyOf(...third)]);
    const put = h.of('decisions').find((d) => d.side === 'put');
    expect(planned(put)).toEqual([keyOf(...top), keyOf(...second), keyOf(...third)]);
    expect(backedOff(put)).toEqual([keyOf(...top)]);
    expect(put?.result).toMatchObject({ kind: 'trade' });
  });

  it('holds a call side whose basis-eligible listings are all backed off rather than falling back below basis', async () => {
    const h = harness('dry-run');
    // At a 90 USD basis only 91.5 and 93.5 (two weeks out) clear it; the fallback strike would be 88.5.
    const basis = { ...wheelConfig().basis, anchor: { ...wheelConfig().basis.anchor, basisE8: 9000000000n } };
    const eligible: [Side, bigint, number][] = [
      ['call', 9150000000n, E2],
      ['call', 9350000000n, E2],
    ];
    for (const listing of eligible)
      h.memo.backoffKey(keyOf(...listing), NOW_SEC, SPOT_E8, listingApr(...listing));
    await runTicks(h, appConfig('dry-run', {}, { basis }), 1);

    expect(vi.mocked(h.deps.quote).mock.calls.filter(([c]) => c.side === 'call')).toEqual([]);
    const call = h.of('decisions').find((d) => d.side === 'call');
    expect(call?.plan).toMatchObject({ kind: 'quote' });
    // The normal path planned the two basis-eligible strikes, both backed off; no fallback strike was planned.
    const keys = eligible.map((listing) => keyOf(...listing));
    expect(planned(call)).toEqual(keys);
    expect(backedOff(call)).toEqual(keys);
    const modes = ((call?.candidates ?? []) as { candidateMode: string }[]).map((c) => c.candidateMode);
    expect(modes).toEqual(['normal', 'normal']);
    expect(call?.result).toMatchObject({ kind: 'hold', reason: 'apr-floor' });
  });

  it('keeps quoting and simulating with the STOP file present (dry-run continues, spec §9.4)', async () => {
    const h = harness('dry-run', { stopFile: vi.fn(() => true) });
    await runTicks(h, appConfig('dry-run'), 1);
    expect(h.of('quotes')).toHaveLength(6);
    expect(h.deps.execute).toHaveBeenCalledOnce();
    expect(h.of('executions')[0]).toMatchObject({ result: { status: 'aborted', stage: 'dry-run' } });
    expect(h.memo.simulatedDeploySec).toEqual({ put: NOW_SEC });
  });

  it('executes only the side pickSide chooses when both sides trade', async () => {
    // 2 USD a call contract: about 130 % net APR, ahead of the put's 98 %.
    const quote = vi.fn(async (c: Candidate) => {
      const outcome = goodQuote(c, Date.now());
      if (c.side === 'put' || !outcome.ok) return outcome;
      return { ...outcome, quote: { ...outcome.quote, price: (2n * 10n ** 18n).toString() } };
    });
    const h = harness('dry-run', { quote });
    await runTicks(h, appConfig('dry-run'), 1);

    const results = h.of('decisions').map((d) => [d.side, (d.result as { kind: string }).kind]);
    expect(results).toEqual([
      ['put', 'trade'],
      ['call', 'trade'],
    ]);
    expect(h.deps.execute).toHaveBeenCalledOnce();
    expect(vi.mocked(h.deps.execute).mock.calls[0]?.[0].side).toBe('call');
    expect(h.memo.simulatedDeploySec).toEqual({ call: NOW_SEC });
  });

  it("records the quote's TTL from the response time on the server clock", async () => {
    const h = harness('dry-run');
    // Our clock runs 1 s ahead of the server's, so on the server clock the answer came 1 s earlier.
    h.memo.serverSkewMs = 1000;
    await runTicks(h, appConfig('dry-run'), 1);
    expect(h.of('quotes')[0]?.quote).toMatchObject({ ttlSec: 60.75 });
  });

  it('redacts the RPC URL and provider keys from recorded error text', async () => {
    const config = appConfig('dry-run', { rpcUrl: 'https://rpc.example.org/secret-path' });
    const key = 'A1b2C3d4E5f6G7h8I9j0';
    // The put RFQs fail naming the RPC URL; the calls, at 2 USD a contract, trade so that `execute` runs.
    const quote = vi.fn(async (c: Candidate): Promise<QuoteOutcome> => {
      const outcome = goodQuote(c, Date.now());
      if (c.side === 'put') {
        const message = 'upstream https://rpc.example.org/secret-path refused';
        return { ok: false, error: 'rpc-error', message, requestedAtMs: Date.now() };
      }
      return outcome.ok
        ? { ...outcome, quote: { ...outcome.quote, price: (2n * 10n ** 18n).toString() } }
        : outcome;
    });
    const execute = vi.fn(async (): Promise<TradeResult> => {
      throw new Error(`fetch https://eth.example.com/v2/${key} failed`);
    });
    const h = harness('dry-run', { quote, execute });
    await runTicks(h, config, 1);

    expect(h.of('executions')).toHaveLength(1);
    const lines = JSON.stringify([...h.of('quotes'), ...h.of('executions')], (_, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(lines).not.toContain(key);
    expect(lines).not.toContain('secret-path');
    expect(lines).toContain('upstream <rpc> refused');
    expect(lines).toContain('fetch https://eth.example.com<rpc> failed');
  });

  it('returns after --max-trades completed (simulated) executions', async () => {
    const h = harness('dry-run');
    await runLoop(h.deps, appConfig('dry-run', { maxTrades: 1 }));
    expect(h.deps.snapshot).toHaveBeenCalledOnce();
    expect(h.deps.execute).toHaveBeenCalledOnce();
  });

  it('keeps quoting in dry-run on a geo-blocked RFQ and never writes STOP', async () => {
    const h = harness('dry-run', {
      quote: vi.fn(async () => ({
        ok: false as const,
        error: 'rpc-error' as const,
        message: 'Forbidden: restricted jurisdiction',
        requestedAtMs: Date.now(),
      })),
    });
    await runTicks(h, appConfig('dry-run'), 1);
    expect(h.deps.quote).toHaveBeenCalledTimes(6);
    expect(h.deps.writeStop).not.toHaveBeenCalled();
    expect(h.of('quotes')[0]).toMatchObject({
      outcome: 'error',
      message: 'Forbidden: restricted jurisdiction',
    });
  });

  it('records a quote that throws as an error outcome and carries on', async () => {
    const quote = vi.fn(async (c: Candidate) => {
      if (c.side === 'put') throw new Error('socket gone');
      return goodQuote(c, Date.now());
    });
    const h = harness('dry-run', { quote });
    await runTicks(h, appConfig('dry-run'), 1);
    const putQuotes = h.of('quotes').filter((q) => q.side === 'put');
    expect(putQuotes).toHaveLength(3);
    expect(putQuotes[0]).toMatchObject({ outcome: 'error', message: 'socket gone' });
    expect(h.of('decisions').find((d) => d.side === 'put')?.result).toMatchObject({ reason: 'no-quotes' });
    expect(h.deps.execute).not.toHaveBeenCalled();
  });

  it('treats an execute that throws as unknown: logged and the side held', async () => {
    const h = harness('dry-run', {
      execute: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await runTicks(h, appConfig('dry-run'), 1);
    expect(h.deps.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ side: 'put' }),
      expect.any(String),
    );
    expect(h.memo.unknownWaits).toHaveLength(1);
    expect(h.memo.cooldownUntilSec.put).toBe(NOW_SEC + 1800);
    expect(h.memo.inFlight).toBe(false);
    expect(h.memo.simulatedDeploySec).toEqual({});
  });

  it('holds G3 while a settlement is pending, warns when it is overdue and restarts the grace after', async () => {
    const overdue = happyPositions().map((p, index) =>
      index === 0 ? { ...p, status: 'open' as const, expirySec: NOW_SEC - 7 * 3600 } : p,
    );
    const snapshot = vi
      .fn<() => Promise<Snapshot>>()
      .mockImplementationOnce(async () => fixtureTick(Date.now(), 'dry-run', overdue))
      .mockImplementation(async () => fixtureTick(Date.now(), 'dry-run'));
    const h = harness('dry-run', { snapshot });
    await runTicks(h, appConfig('dry-run'), 2);

    expect(h.deps.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ expirySec: NOW_SEC - 7 * 3600 }),
      expect.stringContaining('overdue'),
    );
    expect(h.of('decisions').find((d) => d.tick === 1)?.result).toMatchObject({
      reason: 'settlement-pending',
    });
    // The next tick saw none pending: the grace starts then and is not refreshed later.
    expect(h.memo.lastNoPendingSeenSec).toBe(NOW_SEC + 60);
    expect(h.of('decisions').find((d) => d.tick === 2)?.result).toMatchObject({
      reason: 'settlement-pending',
    });
  });
});

describe('runLoop: snapshot failures and shutdown', () => {
  it('holds every failed tick, warns each time and logs one error at the third in a row', async () => {
    const snapshot = vi.fn<() => Promise<Snapshot>>(async () => Promise.reject(new Error('rpc down')));
    const h = harness('dry-run', { snapshot });
    await runTicks(h, appConfig('dry-run'), 4);

    expect(snapshot).toHaveBeenCalledTimes(4);
    expect(h.deps.log.warn).toHaveBeenCalledTimes(4);
    expect(h.deps.log.error).toHaveBeenCalledOnce();
    expect(h.of('decisions')).toEqual([]);
    expect(h.of('quotes')).toEqual([]);
    expect(h.deps.quote).not.toHaveBeenCalled();
    expect(vi.mocked(h.deps.status).mock.calls.at(-1)?.[0]).toMatchObject({
      health: 'holding',
      holdReasons: { put: 'stale-data', call: 'stale-data' },
      tick: 4,
    });
  });

  it('counts only consecutive failures: a good tick resets the count', async () => {
    const error = new Error('rpc down');
    const snapshot = vi
      .fn<() => Promise<Snapshot>>()
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockImplementationOnce(async () => fixtureTick(Date.now(), 'dry-run'))
      .mockRejectedValue(error);
    const h = harness('dry-run', { snapshot });
    const done = runLoop(h.deps, appConfig('dry-run'));
    // Ticks 1–5: two failures, a good tick, two failures.
    await vi.advanceTimersByTimeAsync(4 * TICK_MS);
    expect(h.deps.log.error).not.toHaveBeenCalled();
    // Tick 6: the third failure in a row.
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(h.deps.log.error).toHaveBeenCalledOnce();
    h.controller.abort();
    await done;
  });

  it('ends when the signal aborts during the sleep', async () => {
    const h = harness('dry-run');
    const done = runLoop(h.deps, appConfig('dry-run'));
    await vi.advanceTimersByTimeAsync(30_000);
    h.controller.abort();
    await done;
    expect(h.deps.snapshot).toHaveBeenCalledOnce();
  });

  it('runs no tick when the signal is already aborted', async () => {
    const h = harness('dry-run');
    h.controller.abort();
    await runLoop(h.deps, appConfig('dry-run'));
    expect(h.deps.snapshot).not.toHaveBeenCalled();
  });
});

describe('runLoop: live', () => {
  const filled: TradeResult = {
    status: 'filled',
    txHash: TX,
    quote: putSpike.reply.result,
    premium6: 37_500000n,
    gasFee6: GAS6,
    bookkeepingErrors: [],
  };

  it('executes the picked decision once and waits for its txHash to appear', async () => {
    const h = harness('live', { execute: vi.fn(async () => filled) });
    await runLoop(h.deps, appConfig('live', { maxTrades: 1 }));

    expect(h.deps.execute).toHaveBeenCalledOnce();
    expect(h.deps.vaultCounter).toHaveBeenCalledOnce();
    expect(h.memo.pendingVisibility).toEqual([{ side: 'put', txHash: TX, sinceSec: NOW_SEC }]);
    expect(h.memo.cooldownUntilSec.put).toBe(NOW_SEC + 1800);
    expect(h.memo.simulatedDeploySec).toEqual({});
    expect(h.memo.inFlight).toBe(false);
  });

  it("applies a fill's cooldown before the next tick plans: the side holds 'cooldown'", async () => {
    const h = harness('live', { execute: vi.fn(async () => filled) });
    await runTicks(h, appConfig('live', { maxTrades: 2 }), 2);

    expect(h.deps.execute).toHaveBeenCalledOnce();
    const put = (tick: number) => h.of('decisions').find((d) => d.tick === tick && d.side === 'put');
    expect(put(1)?.result).toMatchObject({ kind: 'trade' });
    expect(put(2)?.result).toMatchObject({ kind: 'hold', reason: 'cooldown' });
    expect(h.memo.pendingVisibility).toHaveLength(1);
  });

  it('never executes while halted, and reports the halt', async () => {
    const h = harness('live');
    h.memo.haltedLive = true;
    await runTicks(h, appConfig('live'), 1);
    expect(h.deps.execute).not.toHaveBeenCalled();
    expect(h.of('decisions').find((d) => d.side === 'put')?.result).toMatchObject({ kind: 'trade' });
    expect(vi.mocked(h.deps.status).mock.calls[0]?.[0]).toMatchObject({ health: 'halted', halted: true });
  });

  it('never executes while the STOP file is present', async () => {
    let stop = false;
    // STOP appears after the snapshot, while quoting: the check right before executing catches it.
    const quote = vi.fn(async (c: Candidate) => {
      stop = true;
      return goodQuote(c, Date.now());
    });
    const h = harness('live', { quote, stopFile: vi.fn(() => stop) });
    await runTicks(h, appConfig('live'), 1);
    expect(h.deps.execute).not.toHaveBeenCalled();
  });

  it('halts live on an RFQ error suggesting a geo block', async () => {
    let calls = 0;
    // The second put RFQ fails; the other two still make a put trade.
    const quote = vi.fn(async (c: Candidate) =>
      ++calls === 2
        ? {
            ok: false as const,
            error: 'rpc-error' as const,
            message: 'access restricted in your region',
            requestedAtMs: Date.now(),
          }
        : goodQuote(c, Date.now()),
    );
    const h = harness('live', { quote });
    await runTicks(h, appConfig('live'), 1);
    expect(h.deps.writeStop).toHaveBeenCalledOnce();
    expect(h.memo.haltedLive).toBe(true);
    expect(h.of('decisions').find((d) => d.side === 'put')?.result).toMatchObject({ kind: 'trade' });
    expect(h.deps.execute).not.toHaveBeenCalled();
  });
});
