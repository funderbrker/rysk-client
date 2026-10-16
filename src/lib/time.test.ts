import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sleep, systemClock } from './time.ts';

describe('sleep', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves after the given delay', async () => {
    let done = false;
    const p = sleep(1000).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
  });

  it('resolves early when the signal aborts', async () => {
    const controller = new AbortController();
    const p = sleep(60_000, controller.signal);
    controller.abort();
    await expect(p).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves immediately when the signal is already aborted', async () => {
    await expect(sleep(60_000, AbortSignal.abort())).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('systemClock', () => {
  it('reports wall-clock milliseconds', () => {
    const before = Date.now();
    const now = systemClock.nowMs();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});
