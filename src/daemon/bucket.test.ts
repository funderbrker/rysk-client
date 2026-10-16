import { describe, expect, it } from 'vitest';
import { combinedBucket, TokenBucket } from './bucket.ts';

function manualClock(startMs = 1_000_000) {
  let nowMs = startMs;
  return {
    clock: { nowMs: () => nowMs },
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

function takeAll(bucket: Pick<TokenBucket, 'take'>): number {
  let taken = 0;
  while (bucket.take()) taken += 1;
  return taken;
}

describe('TokenBucket', () => {
  it('starts full: perMinute 6 allows 6 immediate takes, then one more after 10 s', () => {
    const { clock, advance } = manualClock();
    const bucket = new TokenBucket(6, clock);
    for (let i = 0; i < 6; i++) expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);

    advance(9_999);
    expect(bucket.take()).toBe(false);
    advance(1);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
  });

  it('says how long until the next whole token, 0 while one is available', () => {
    const { clock, advance } = manualClock();
    const bucket = new TokenBucket(6, clock);
    expect(bucket.waitMs()).toBe(0);
    takeAll(bucket);
    expect(bucket.waitMs()).toBe(10_000);
    advance(4_000);
    expect(bucket.waitMs()).toBe(6_000);
    advance(6_000);
    expect(bucket.waitMs()).toBe(0);
  });

  it('refills continuously but never above its capacity', () => {
    const { clock, advance } = manualClock();
    const bucket = new TokenBucket(12, clock);
    takeAll(bucket);
    advance(15_000);
    expect(takeAll(bucket)).toBe(3);
    advance(3_600_000);
    expect(takeAll(bucket)).toBe(12);
  });

  it('grants nothing for time the clock went back', () => {
    const { clock, advance } = manualClock();
    const bucket = new TokenBucket(6, clock);
    takeAll(bucket);
    advance(-30_000);
    expect(bucket.take()).toBe(false);
    advance(30_000);
    expect(bucket.take()).toBe(false);
    advance(10_000);
    expect(bucket.take()).toBe(true);
  });

  it('rejects a rate that is not a positive finite number', () => {
    const { clock } = manualClock();
    for (const perMinute of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new TokenBucket(perMinute, clock)).toThrow(RangeError);
    }
  });
});

describe('combinedBucket', () => {
  it('denies while either bucket is empty, taking nothing from the other', () => {
    const { clock, advance } = manualClock();
    const own = new TokenBucket(2, clock);
    const hardCap = new TokenBucket(1, clock);
    const both = combinedBucket(own, hardCap);

    expect(both.take()).toBe(true);
    // The hard cap is empty: denied, and `own` keeps its last token.
    expect(both.take()).toBe(false);
    expect(own.waitMs()).toBe(0);
    expect(both.waitMs()).toBe(60_000);

    advance(60_000);
    expect(takeAll(own)).toBe(2);
    // Now `own` is empty: denied, and the hard cap keeps the token it refilled.
    expect(both.take()).toBe(false);
    expect(hardCap.waitMs()).toBe(0);
    expect(both.waitMs()).toBe(30_000);
  });

  it('bounds the sum of two loops by the shared hard cap', () => {
    const { clock } = manualClock();
    const sampler = new TokenBucket(6, clock);
    const hardCap = new TokenBucket(15, clock);
    const strategyRfqs = combinedBucket(new TokenBucket(12, clock), hardCap);
    const samplerRfqs = combinedBucket(sampler, hardCap);

    expect(takeAll(strategyRfqs)).toBe(12);
    // The hard cap has 3 left of 15: the sampler gets 3 of its 6 and keeps the other 3.
    expect(takeAll(samplerRfqs)).toBe(3);
    expect(sampler.waitMs()).toBe(0);
    expect(samplerRfqs.waitMs()).toBe(4_000);
  });
});
