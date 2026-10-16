import { readFileSync } from 'node:fs';
import { getAddress } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import type { ConfirmBody, GasPreviewBody } from '../domain/index.ts';
import { CallTimeoutError, RestError } from './errors.ts';
import { RyskRest, type RyskRestOptions } from './rest.ts';

const BASE = 'https://v12.rysk.finance';
const SELF = getAddress('0x000000000000000000000000000000000000beef');
const DATE_HEADER = 'Fri, 16 Oct 2026 10:28:36 GMT';

type GasRoundTrip = { sent: ConfirmBody; body: string };
const capture = JSON.parse(
  readFileSync(new URL('../../test/fixtures/spike-capture.json', import.meta.url), 'utf8'),
) as { gas: { full: GasRoundTrip; preview: { sent: GasPreviewBody } } };

type Reply = { status: number; body?: string; headers?: Record<string, string> } | Error;

/** A fake `fetch` that serves `replies` in order; an `Error` reply makes that call reject like a network error. */
function fakeFetch(...replies: Reply[]) {
  return vi.fn<typeof fetch>(async () => {
    const next = replies.shift();
    if (next === undefined) throw new Error('unexpected fetch call');
    if (next instanceof Error) throw next;
    return new Response(next.body ?? '', { status: next.status, headers: next.headers });
  });
}

function client(fetchFn: typeof fetch, extra: Partial<RyskRestOptions> = {}) {
  const sleep = vi.fn(async (_ms: number) => {});
  const onServerDate = vi.fn((_serverMs: number) => {});
  const rest = new RyskRest({ baseUrl: BASE, fetch: fetchFn, sleep, onServerDate, ...extra });
  return { rest, sleep, onServerDate };
}

function sleptMs(sleep: ReturnType<typeof client>['sleep']): number[] {
  return sleep.mock.calls.map(([ms]) => ms);
}

describe('RyskRest GET endpoints', () => {
  it('returns the parsed JSON of /api/assets and reports the Date header as epoch ms', async () => {
    const fetchFn = fakeFetch({
      status: 200,
      body: '{"assets":[{"symbol":"WHYPE"}]}',
      headers: { date: DATE_HEADER },
    });
    const { rest, onServerDate } = client(fetchFn);

    await expect(rest.assets()).resolves.toEqual({ assets: [{ symbol: 'WHYPE' }] });

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0]?.[0]).toBe(`${BASE}/api/assets`);
    expect(fetchFn.mock.calls[0]?.[1]?.method).toBe('GET');
    expect(onServerDate).toHaveBeenCalledExactlyOnceWith(Date.UTC(2026, 9, 16, 10, 28, 36));
  });

  it.each([
    ['inventory', (rest: RyskRest) => rest.inventory(), `${BASE}/api/inventory`],
    ['caps', (rest: RyskRest) => rest.caps(), `${BASE}/api/caps`],
    [
      'userPositions',
      (rest: RyskRest) => rest.userPositions(SELF),
      `${BASE}/api/user/positions?address=${SELF}`,
    ],
    [
      'publicHistory',
      (rest: RyskRest) => rest.publicHistory(1792000000, 1792146516),
      `${BASE}/api/history?from=1792000000&to=1792146516`,
    ],
  ])('%s GETs its path and returns the parsed JSON', async (_name, call, url) => {
    const fetchFn = fakeFetch({ status: 200, body: '[{"k":1}]' });
    const { rest } = client(fetchFn);

    await expect(call(rest)).resolves.toEqual([{ k: 1 }]);
    expect(fetchFn).toHaveBeenCalledExactlyOnceWith(url, expect.objectContaining({ method: 'GET' }));
  });

  it('retries two 500s with 100 ms then 500 ms backoff and resolves on the third call', async () => {
    const fetchFn = fakeFetch({ status: 500 }, { status: 500 }, { status: 200, body: '{"ok":true}' });
    const { rest, sleep } = client(fetchFn);

    await expect(rest.caps()).resolves.toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleptMs(sleep)).toEqual([100, 500]);
  });

  it('retries a network error and resolves on the next call', async () => {
    const fetchFn = fakeFetch(new TypeError('fetch failed'), { status: 200, body: '[]' });
    const { rest, sleep } = client(fetchFn);

    await expect(rest.inventory()).resolves.toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleptMs(sleep)).toEqual([100]);
  });

  it('throws RestError with the last 5xx status and body after three retries', async () => {
    const fetchFn = fakeFetch(...Array.from({ length: 4 }, () => ({ status: 503, body: 'unavailable' })));
    const { rest, sleep } = client(fetchFn);

    const error = await rest.assets().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RestError);
    expect(error).toMatchObject({ status: 503, message: 'unavailable' });
    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(sleptMs(sleep)).toEqual([100, 500, 2500]);
  });

  it('caps the backoff at 5 s', async () => {
    const fetchFn = fakeFetch(...Array.from({ length: 6 }, () => ({ status: 502 })));
    const { rest, sleep } = client(fetchFn, { retries: 5 });

    await expect(rest.assets()).rejects.toBeInstanceOf(RestError);
    expect(sleptMs(sleep)).toEqual([100, 500, 2500, 5000, 5000]);
  });

  it('rethrows the last network error once the retries are spent', async () => {
    const last = new TypeError('fetch failed: last');
    const fetchFn = fakeFetch(
      new TypeError('fetch failed'),
      new TypeError('fetch failed'),
      new TypeError('fetch failed'),
      last,
    );
    const { rest } = client(fetchFn);

    await expect(rest.caps()).rejects.toBe(last);
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it('throws RestError on a 400 after one call, without retrying', async () => {
    const fetchFn = fakeFetch({ status: 400, body: 'Invalid address' });
    const { rest, sleep } = client(fetchFn);

    const error = await rest.userPositions(SELF).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RestError);
    expect(error).toMatchObject({ status: 400, message: 'Invalid address' });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('keeps at most 300 characters of an error body in the message', async () => {
    const body = `<html>${'x'.repeat(1_000)}</html>`;
    const { rest } = client(fakeFetch({ status: 404, body }));

    const error = await rest.caps().catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 404, message: `${body.slice(0, 300)}… (${body.length} chars)` });
  });

  it('throws RestError when a 2xx body is not JSON', async () => {
    const fetchFn = fakeFetch({ status: 200, body: '<html>maintenance</html>' });
    const { rest } = client(fetchFn);

    await expect(rest.assets()).rejects.toMatchObject({ name: 'RestError', status: 200 });
  });

  it('reports the Date header of every response, retried ones included, and skips missing or bad dates', async () => {
    const fetchFn = fakeFetch(
      { status: 500, headers: { date: 'Fri, 16 Oct 2026 10:28:35 GMT' } },
      { status: 500, headers: { date: 'not a date' } },
      { status: 500 },
      { status: 200, body: '{}', headers: { date: DATE_HEADER } },
    );
    const { rest, onServerDate } = client(fetchFn);

    await rest.assets();
    expect(onServerDate.mock.calls).toEqual([
      [Date.UTC(2026, 9, 16, 10, 28, 35)],
      [Date.UTC(2026, 9, 16, 10, 28, 36)],
    ]);
  });

  it('rejects with CallTimeoutError when fetch never settles, without retrying', async () => {
    const fetchFn = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    const { rest, sleep } = client(fetchFn, { timeoutMs: 50 });

    const error = await rest.assets().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CallTimeoutError);
    expect(error).toMatchObject({ message: 'GET /api/assets timed out after 50 ms', sent: true });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('RyskRest.gasFee', () => {
  it('POSTs the body as JSON and returns the echoed response with gasFee6 from the spike capture', async () => {
    const { sent, body } = capture.gas.full;
    const fetchFn = fakeFetch({ status: 200, body, headers: { 'content-type': 'application/json' } });
    const { rest } = client(fetchFn);

    const result = await rest.gasFee(sent);

    expect(result).toEqual({ ok: true, gasFee6: 0n, echoed: JSON.parse(body) });
    if (!result.ok) throw new Error('expected ok');
    expect(result.echoed.gasFee).toBe('0');
    expect(result.echoed.collateralAmount).toBe('1950000000');
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe(`${BASE}/api/gas`);
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual(sent);
  });

  it.each([
    ['a non-zero fee', { gasFee: '1500000' }, 1500000n],
    ['an empty fee', { gasFee: '' }, 0n],
    ['a missing fee', {}, 0n],
  ])('reads %s as gasFee6', async (_name, response, gasFee6) => {
    const { rest } = client(fakeFetch({ status: 200, body: JSON.stringify(response) }));

    await expect(rest.gasFee(capture.gas.preview.sent)).resolves.toEqual({
      ok: true,
      gasFee6,
      echoed: response,
    });
  });

  it('maps a 400 "gas fee more than premium" to exceeds-premium after one call', async () => {
    const fetchFn = fakeFetch({ status: 400, body: 'gas fee more than premium' });
    const { rest } = client(fetchFn);

    await expect(rest.gasFee(capture.gas.full.sent)).resolves.toEqual({
      ok: false,
      reason: 'exceeds-premium',
      status: 400,
      message: 'gas fee more than premium',
    });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('tells exceeds-premium from the whole body but keeps at most 300 characters of it', async () => {
    const body = `${'detail '.repeat(100)}gas fee more than premium`;
    const { rest } = client(fakeFetch({ status: 400, body }));

    await expect(rest.gasFee(capture.gas.full.sent)).resolves.toEqual({
      ok: false,
      reason: 'exceeds-premium',
      status: 400,
      message: `${body.slice(0, 300)}… (${body.length} chars)`,
    });
  });

  it('maps any other 4xx to http without retrying', async () => {
    const fetchFn = fakeFetch({ status: 422, body: 'invalid strike' });
    const { rest } = client(fetchFn);

    await expect(rest.gasFee(capture.gas.full.sent)).resolves.toEqual({
      ok: false,
      reason: 'http',
      status: 422,
      message: 'invalid strike',
    });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('retries 5xx and returns http once the retries are spent', async () => {
    const fetchFn = fakeFetch(...Array.from({ length: 4 }, () => ({ status: 500, body: 'internal error' })));
    const { rest } = client(fetchFn);

    await expect(rest.gasFee(capture.gas.full.sent)).resolves.toEqual({
      ok: false,
      reason: 'http',
      status: 500,
      message: 'internal error',
    });
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it('throws RestError when a 2xx body is not an object', async () => {
    const { rest } = client(fakeFetch({ status: 200, body: '["0"]' }));

    await expect(rest.gasFee(capture.gas.full.sent)).rejects.toMatchObject({
      name: 'RestError',
      status: 200,
      message: 'gas response is not an object',
    });
  });

  it.each([['-1'], ['1.5'], [0]])('throws RestError when gasFee is %j', async (gasFee) => {
    const { rest } = client(fakeFetch({ status: 200, body: JSON.stringify({ gasFee }) }));

    await expect(rest.gasFee(capture.gas.full.sent)).rejects.toMatchObject({
      name: 'RestError',
      status: 200,
    });
  });
});
