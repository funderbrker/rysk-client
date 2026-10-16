import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FrontendVersionWatcher } from './version.ts';

const APP_URL = 'https://example.invalid';
const VERSION_URL = 'https://example.invalid/api/version/';
const HOUR_MS = 3_600_000;

type Reply = string | Error | Response;

/** A fake `fetch` answering each call with the next reply: a sha, a rejection, or a raw response. */
function fakeFetch(...replies: Reply[]) {
  return vi.fn<typeof fetch>(async () => {
    const reply = replies.shift();
    if (reply === undefined) throw new Error('no reply left');
    if (reply instanceof Error) throw reply;
    if (reply instanceof Response) return reply;
    return Response.json({ sha: reply, timestamp: '2026-10-16T00:00:00Z' });
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('FrontendVersionWatcher', () => {
  it('takes the first sha as the baseline and flags a different later sha', async () => {
    const fetch = fakeFetch('a', 'b');
    const watcher = new FrontendVersionWatcher({ appUrl: APP_URL, fetch });

    await watcher.start();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      VERSION_URL,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(watcher.sha).toBe('a');
    expect(watcher.changed).toBe(false);

    await vi.advanceTimersByTimeAsync(HOUR_MS - 1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(watcher.sha).toBe('b');
    expect(watcher.changed).toBe(true);
    watcher.stop();
  });

  it('stays changed when the sha later returns to the baseline', async () => {
    const watcher = new FrontendVersionWatcher({ appUrl: APP_URL, fetch: fakeFetch('a', 'b', 'a') });

    await watcher.start();
    await vi.advanceTimersByTimeAsync(2 * HOUR_MS);

    expect(watcher.sha).toBe('a');
    expect(watcher.changed).toBe(true);
    watcher.stop();
  });

  it('keeps an unchanged sha unflagged', async () => {
    const watcher = new FrontendVersionWatcher({ appUrl: APP_URL, fetch: fakeFetch('a', 'a', 'a') });

    await watcher.start();
    await vi.advanceTimersByTimeAsync(2 * HOUR_MS);

    expect(watcher.sha).toBe('a');
    expect(watcher.changed).toBe(false);
    watcher.stop();
  });

  it('resolves start() after a failed first poll and takes the first successful sha as the baseline', async () => {
    const failure = new Error('network down');
    const onError = vi.fn();
    const fetch = fakeFetch(failure, 'a', 'a');
    const watcher = new FrontendVersionWatcher({ appUrl: APP_URL, fetch, onError });

    await watcher.start();

    expect(watcher.sha).toBeNull();
    expect(watcher.changed).toBe(false);
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);

    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(watcher.sha).toBe('a');
    expect(watcher.changed).toBe(false);

    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(watcher.sha).toBe('a');
    expect(watcher.changed).toBe(false);
    watcher.stop();
  });

  it('never changes state on a failed poll: rejection, HTTP error or a body without a sha', async () => {
    const onError = vi.fn();
    const fetch = fakeFetch(
      'a',
      new Error('timeout'),
      new Response('bad gateway', { status: 502 }),
      Response.json({ timestamp: 'x' }),
      Response.json({ sha: '' }),
      Response.json({ sha: 7 }),
      new Response('not json'),
    );
    const watcher = new FrontendVersionWatcher({ appUrl: APP_URL, fetch, onError });

    await watcher.start();
    await vi.advanceTimersByTimeAsync(6 * HOUR_MS);

    expect(fetch).toHaveBeenCalledTimes(7);
    expect(onError).toHaveBeenCalledTimes(6);
    expect(watcher.sha).toBe('a');
    expect(watcher.changed).toBe(false);
    watcher.stop();
  });

  it('works without onError', async () => {
    const watcher = new FrontendVersionWatcher({ appUrl: APP_URL, fetch: fakeFetch(new Error('down')) });

    await expect(watcher.start()).resolves.toBeUndefined();
    expect(watcher.sha).toBeNull();
    watcher.stop();
  });

  it('polls at the configured interval and tolerates a trailing slash on appUrl', async () => {
    const fetch = fakeFetch('a', 'b');
    const watcher = new FrontendVersionWatcher({ appUrl: `${APP_URL}/`, fetch, intervalMs: 60_000 });

    await watcher.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetch).toHaveBeenNthCalledWith(2, VERSION_URL, expect.anything());
    expect(watcher.changed).toBe(true);
    watcher.stop();
  });

  it('schedules polls on a timer that does not keep the process alive', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const watcher = new FrontendVersionWatcher({ appUrl: APP_URL, fetch: fakeFetch('a') });

    await watcher.start();

    const timer = setIntervalSpy.mock.results[0]?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    watcher.stop();
    setIntervalSpy.mockRestore();
  });

  it('stop() prevents further polls', async () => {
    const fetch = fakeFetch('a', 'b');
    const watcher = new FrontendVersionWatcher({ appUrl: APP_URL, fetch });

    await watcher.start();
    watcher.stop();
    await vi.advanceTimersByTimeAsync(3 * HOUR_MS);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(watcher.changed).toBe(false);
  });

  it('stop() during the first poll prevents the repeating polls', async () => {
    const fetch = fakeFetch('a', 'b');
    const watcher = new FrontendVersionWatcher({ appUrl: APP_URL, fetch });

    const started = watcher.start();
    watcher.stop();
    await started;
    await vi.advanceTimersByTimeAsync(3 * HOUR_MS);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(watcher.sha).toBe('a');
  });
});
