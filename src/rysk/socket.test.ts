import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallTimeoutError, RyskRpcError, SocketClosedError } from './errors.ts';
import { JsonRpcSocket, type SocketOptions } from './socket.ts';

const URL = 'wss://v12.rysk.finance/taker';

/** Records sent frames; the test drives `open`, `message`, `close` and `error` with `emit`. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly sent: string[] = [];
  readyState = 0;
  closeCalls = 0;
  failSend = false;
  readonly #listeners = new Map<string, Array<(event: Event) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    if (this.failSend) throw new DOMException('not open', 'InvalidStateError');
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    if (this.readyState !== 3) this.emit('close');
  }

  emit(type: 'open' | 'message' | 'close' | 'error', data?: unknown): void {
    if (type === 'open') this.readyState = 1;
    if (type === 'close') this.readyState = 3;
    const event = type === 'message' ? new MessageEvent(type, { data }) : new Event(type);
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }

  reply(frame: Record<string, unknown>): void {
    this.emit('message', JSON.stringify({ jsonrpc: '2.0', ...frame }));
  }

  frames(): unknown[] {
    return this.sent.map((frame) => JSON.parse(frame));
  }
}

function socketWith(extra: Partial<SocketOptions> = {}): JsonRpcSocket {
  return new JsonRpcSocket({
    url: URL,
    createWebSocket: (url) => new FakeWebSocket(url),
    random: () => 0.5,
    ...extra,
  });
}

function wsAt(index: number): FakeWebSocket {
  const ws = FakeWebSocket.instances[index];
  if (ws === undefined) throw new Error(`no FakeWebSocket #${index}`);
  return ws;
}

/** Emits `open` on the newest socket and waits out the default 500 ms settle. */
async function openLatest(): Promise<FakeWebSocket> {
  const ws = wsAt(FakeWebSocket.instances.length - 1);
  ws.emit('open');
  await vi.advanceTimersByTimeAsync(500);
  return ws;
}

/** Captures the settlement of `promise` without letting a rejection go unhandled. */
function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  promise.then(
    (value) => Object.assign(state, { settled: true, value }),
    (error: unknown) => Object.assign(state, { settled: true, error }),
  );
  return state;
}

const frame = (method: string, params: unknown) => ({ jsonrpc: '2.0', method, id: method, params });

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('JsonRpcSocket', () => {
  it('(a) connects on demand, sends the frame 500 ms after open and resolves with the result', async () => {
    const socket = socketWith();
    expect(socket.state).toBe('idle');
    expect(FakeWebSocket.instances).toHaveLength(0);

    const assets = socket.call('assets', {}, { timeoutMs: 5_000 });
    const ws = wsAt(0);
    expect(ws.url).toBe(URL);
    expect(socket.state).toBe('connecting');

    ws.emit('open');
    await vi.advanceTimersByTimeAsync(499);
    expect(ws.sent).toEqual([]);
    expect(socket.state).toBe('connecting');
    await vi.advanceTimersByTimeAsync(1);
    expect(ws.sent).toEqual(['{"jsonrpc":"2.0","method":"assets","id":"assets","params":{}}']);
    expect(socket.state).toBe('open');
    expect(socket.connectionId).toBe(1);

    ws.reply({ id: 'assets', result: { assets: [{ symbol: 'WHYPE' }] } });
    await expect(assets).resolves.toEqual({ assets: [{ symbol: 'WHYPE' }] });
  });

  it('(b) ignores a reply that fails accept and resolves on a later matching one', async () => {
    const socket = socketWith();
    const accept = vi.fn((result: unknown) => (result as { strike: string }).strike === '4000000000');
    const quote = track(socket.call('request', { strike: '4000000000' }, { timeoutMs: 5_000, accept }));
    const ws = await openLatest();

    ws.reply({ id: 'request', result: { strike: '3500000000' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(quote.settled).toBe(false);

    ws.reply({ id: 'request', result: { strike: '4000000000' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(quote).toEqual({ settled: true, value: { strike: '4000000000' } });
    expect(accept).toHaveBeenCalledTimes(2);
  });

  it('(b) treats an accept that throws as not accepted and keeps waiting', async () => {
    const warn = vi.fn();
    const socket = socketWith({ logger: { debug: vi.fn(), warn } });
    const accept = (result: unknown) => BigInt((result as { strike: string }).strike) === 4000000000n;
    const quote = track(socket.call('request', {}, { timeoutMs: 5_000, accept }));
    const ws = await openLatest();

    expect(() => ws.reply({ id: 'request', result: { strike: 'not-a-number' } })).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(quote.settled).toBe(false);
    expect(warn).toHaveBeenCalledOnce();

    ws.reply({ id: 'request', result: { strike: '4000000000' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(quote).toEqual({ settled: true, value: { strike: '4000000000' } });
  });

  it('(c) rejects with CallTimeoutError at the deadline, counted from the call, and ignores a late reply', async () => {
    const socket = socketWith();
    const assets = track(socket.call('assets', {}, { timeoutMs: 2_000 }));
    const ws = await openLatest();
    expect(ws.sent).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_499);
    expect(assets.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(assets.error).toBeInstanceOf(CallTimeoutError);
    expect(assets.error).toMatchObject({ sent: true });

    expect(() => ws.reply({ id: 'assets', result: 'late' })).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(assets.value).toBeUndefined();
  });

  it('(d) serializes calls of one method and lets other methods interleave', async () => {
    const socket = socketWith();
    const first = track(socket.call('request', { n: 1 }, { timeoutMs: 5_000 }));
    const second = track(socket.call('request', { n: 2 }, { timeoutMs: 5_000 }));
    const ws = await openLatest();
    expect(ws.frames()).toEqual([frame('request', { n: 1 })]);

    const caps = track(socket.call('caps', {}, { timeoutMs: 5_000 }));
    expect(ws.frames()).toEqual([frame('request', { n: 1 }), frame('caps', {})]);
    ws.reply({ id: 'caps', result: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(caps).toEqual({ settled: true, value: [] });
    expect(ws.sent).toHaveLength(2);

    ws.reply({ id: 'request', result: 'one' });
    await vi.advanceTimersByTimeAsync(0);
    expect(first).toEqual({ settled: true, value: 'one' });
    expect(second.settled).toBe(false);
    expect(ws.frames()).toEqual([frame('request', { n: 1 }), frame('caps', {}), frame('request', { n: 2 })]);

    ws.reply({ id: 'request', result: 'two' });
    await vi.advanceTimersByTimeAsync(0);
    expect(second).toEqual({ settled: true, value: 'two' });
  });

  it('(e) rejects a pending call with SocketClosedError and reconnects for the next call after baseMs', async () => {
    const socket = socketWith();
    const assets = track(socket.call('assets', {}, { timeoutMs: 5_000 }));
    const ws = await openLatest();

    ws.emit('close');
    await vi.advanceTimersByTimeAsync(0);
    expect(assets.error).toBeInstanceOf(SocketClosedError);
    expect(assets.error).toMatchObject({ sent: true });
    expect(socket.state).toBe('closed');

    const again = track(socket.call('assets', {}, { timeoutMs: 5_000 }));
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    const ws2 = await openLatest();
    expect(socket.connectionId).toBe(2);
    expect(ws2.frames()).toEqual([frame('assets', {})]);
    ws2.reply({ id: 'assets', result: 'fresh' });
    await vi.advanceTimersByTimeAsync(0);
    expect(again).toEqual({ settled: true, value: 'fresh' });
  });

  it('(e) keeps unsent calls queued across a close, reconnects for them and ignores the old socket', async () => {
    const socket = socketWith();
    const first = track(socket.call('request', { n: 1 }, { timeoutMs: 10_000 }));
    const second = track(socket.call('request', { n: 2 }, { timeoutMs: 10_000 }));
    const ws = await openLatest();

    ws.emit('close');
    await vi.advanceTimersByTimeAsync(0);
    expect(first.error).toBeInstanceOf(SocketClosedError);
    expect(second.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    const ws2 = await openLatest();
    expect(ws2.frames()).toEqual([frame('request', { n: 2 })]);

    ws.reply({ id: 'request', result: 'stale' });
    ws.emit('close');
    await vi.advanceTimersByTimeAsync(0);
    expect(second.settled).toBe(false);
    expect(socket.state).toBe('open');

    ws2.reply({ id: 'request', result: 'two' });
    await vi.advanceTimersByTimeAsync(0);
    expect(second).toEqual({ settled: true, value: 'two' });
  });

  it('(f) retries a socket that does not open within connectTimeoutMs, doubling the backoff until an open resets it', async () => {
    const socket = socketWith();
    const assets = track(socket.call('assets', {}, { timeoutMs: 60_000 }));

    await vi.advanceTimersByTimeAsync(10_000);
    expect(wsAt(0).closeCalls).toBe(1);
    expect(socket.state).toBe('closed');
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(socket.state).toBe('connecting');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(wsAt(1).closeCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(3);

    const ws3 = await openLatest();
    ws3.reply({ id: 'assets', result: 'ok' });
    await vi.advanceTimersByTimeAsync(0);
    expect(assets).toEqual({ settled: true, value: 'ok' });
    expect(socket.connectionId).toBe(1);

    ws3.emit('close');
    track(socket.call('assets', {}, { timeoutMs: 5_000 }));
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeWebSocket.instances).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it('(f) applies jitter and capMs to the backoff after socket errors', async () => {
    const socket = socketWith({ backoff: { baseMs: 1_000, capMs: 3_000, jitter: 0.25 }, random: () => 0 });
    track(socket.call('assets', {}, { timeoutMs: 60_000 }));

    for (const delayMs of [750, 1_500, 2_250, 2_250]) {
      const count = FakeWebSocket.instances.length;
      wsAt(count - 1).emit('error');
      expect(wsAt(count - 1).closeCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(delayMs - 1);
      expect(FakeWebSocket.instances).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeWebSocket.instances).toHaveLength(count + 1);
    }
  });

  it('(f) backs off and retries when the socket factory throws', async () => {
    let throws = true;
    const socket = socketWith({
      createWebSocket: (url) => {
        if (throws) throw new SyntaxError('bad url');
        return new FakeWebSocket(url);
      },
    });
    const assets = track(socket.call('assets', {}, { timeoutMs: 5_000 }));
    expect(socket.state).toBe('closed');

    throws = false;
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeWebSocket.instances).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    const ws = await openLatest();
    ws.reply({ id: 'assets', result: 'ok' });
    await vi.advanceTimersByTimeAsync(0);
    expect(assets).toEqual({ settled: true, value: 'ok' });
  });

  it('(g) closes the socket after idleCloseMs with nothing pending and reconnects on the next call', async () => {
    const socket = socketWith();
    const first = socket.call('assets', {}, { timeoutMs: 5_000 });
    const ws = await openLatest();
    ws.reply({ id: 'assets', result: 1 });
    await first;

    await vi.advanceTimersByTimeAsync(20_000);
    const second = socket.call('assets', {}, { timeoutMs: 5_000 });
    ws.reply({ id: 'assets', result: 2 });
    await second;

    await vi.advanceTimersByTimeAsync(29_999);
    expect(ws.closeCalls).toBe(0);
    expect(socket.state).toBe('open');
    await vi.advanceTimersByTimeAsync(1);
    expect(ws.closeCalls).toBe(1);
    expect(socket.state).toBe('idle');

    track(socket.call('assets', {}, { timeoutMs: 5_000 }));
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('(h) rejects an error reply with RyskRpcError carrying its code', async () => {
    const socket = socketWith();
    const probe = track(socket.call('probe', {}, { timeoutMs: 5_000 }));
    const ws = await openLatest();

    ws.reply({ id: 'probe', error: { code: -32601, message: 'Method not found' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(probe.error).toBeInstanceOf(RyskRpcError);
    expect(probe.error).toMatchObject({ code: -32601, message: 'Method not found' });
  });

  it('(i) rejects a queued call whose deadline passes before it is sent, without sending it', async () => {
    const socket = socketWith();
    const first = track(socket.call('request', { n: 1 }, { timeoutMs: 10_000 }));
    const second = track(socket.call('request', { n: 2 }, { timeoutMs: 1_000 }));
    const ws = await openLatest();

    await vi.advanceTimersByTimeAsync(500);
    expect(second.error).toBeInstanceOf(CallTimeoutError);
    expect(second.error).toMatchObject({ sent: false });
    ws.reply({ id: 'request', result: 'one' });
    await vi.advanceTimersByTimeAsync(0);
    expect(first).toEqual({ settled: true, value: 'one' });
    expect(ws.frames()).toEqual([frame('request', { n: 1 })]);
  });

  it('rejects with the abort reason: at once when already aborted, and unsent when aborted while queued', async () => {
    const socket = socketWith();
    const stop = new Error('stop');
    await expect(
      socket.call('assets', {}, { timeoutMs: 1_000, signal: AbortSignal.abort(stop) }),
    ).rejects.toBe(stop);
    expect(FakeWebSocket.instances).toHaveLength(0);

    const controller = new AbortController();
    const first = track(socket.call('request', { n: 1 }, { timeoutMs: 5_000 }));
    const second = track(socket.call('request', { n: 2 }, { timeoutMs: 5_000, signal: controller.signal }));
    const ws = await openLatest();
    controller.abort(stop);
    await vi.advanceTimersByTimeAsync(0);
    expect(second.error).toBe(stop);

    ws.reply({ id: 'request', result: 'one' });
    await vi.advanceTimersByTimeAsync(0);
    expect(first.settled).toBe(true);
    expect(ws.frames()).toEqual([frame('request', { n: 1 })]);
  });

  it('sends the next queued call with accept on the same connection when the in-flight one is aborted', async () => {
    const socket = socketWith();
    const controller = new AbortController();
    const first = track(socket.call('request', { n: 1 }, { timeoutMs: 5_000, signal: controller.signal }));
    const accept = (result: unknown) => result === 'two';
    const second = track(socket.call('request', { n: 2 }, { timeoutMs: 5_000, accept }));
    const ws = await openLatest();

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(first.error).toBeInstanceOf(DOMException);
    expect(ws.frames()).toEqual([frame('request', { n: 1 }), frame('request', { n: 2 })]);
    expect(FakeWebSocket.instances).toHaveLength(1);

    ws.reply({ id: 'request', result: 'one' });
    ws.reply({ id: 'request', result: 'two' });
    await vi.advanceTimersByTimeAsync(0);
    expect(second).toEqual({ settled: true, value: 'two' });
  });

  it('takes one error reply as the late answer to a timed-out call of the method, then rejects the next', async () => {
    const socket = socketWith();
    const accept = (result: unknown) => result === 'two';
    const first = track(socket.call('request', { n: 1 }, { timeoutMs: 1_000, accept }));
    const ws = await openLatest();
    await vi.advanceTimersByTimeAsync(500);
    expect(first.error).toBeInstanceOf(CallTimeoutError);

    const second = track(socket.call('request', { n: 2 }, { timeoutMs: 10_000, accept }));
    expect(ws.frames()).toEqual([frame('request', { n: 1 }), frame('request', { n: 2 })]);

    ws.reply({ id: 'request', error: { code: -32603, message: 'custom strikes require volume' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(second.settled).toBe(false);

    ws.reply({ id: 'request', error: { code: -32603, message: 'custom strikes require volume' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(second.error).toBeInstanceOf(RyskRpcError);
    expect(second.error).toMatchObject({ code: -32603 });
  });

  it('rejects the next call with an error reply once a stale result has answered the timed-out call', async () => {
    const socket = socketWith();
    const accept = (result: unknown) => result === 'two';
    const first = track(socket.call('request', { n: 1 }, { timeoutMs: 1_000, accept }));
    const ws = await openLatest();
    await vi.advanceTimersByTimeAsync(500);
    expect(first.error).toBeInstanceOf(CallTimeoutError);

    const second = track(socket.call('request', { n: 2 }, { timeoutMs: 10_000, accept }));
    ws.reply({ id: 'request', result: 'one' });
    ws.reply({ id: 'request', error: { code: -32000, message: 'no makers' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(second.error).toBeInstanceOf(RyskRpcError);
    expect(second.error).toMatchObject({ code: -32000 });
  });

  it('never sends a call without accept where a timed-out call of its method may still be answered', async () => {
    const socket = socketWith();
    const a = track(socket.call('confirm', { n: 'A' }, { timeoutMs: 1_000 }));
    const ws = await openLatest();
    await vi.advanceTimersByTimeAsync(500);
    expect(a.error).toBeInstanceOf(CallTimeoutError);
    expect(a.error).toMatchObject({ sent: true });

    const b = track(socket.call('confirm', { n: 'B' }, { timeoutMs: 10_000 }));
    expect(ws.frames()).toEqual([frame('confirm', { n: 'A' })]);
    expect(ws.closeCalls).toBe(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    const ws2 = await openLatest();
    expect(socket.connectionId).toBe(2);
    expect(ws2.frames()).toEqual([frame('confirm', { n: 'B' })]);

    ws.reply({ id: 'confirm', result: `0x${'aa'.repeat(32)}` });
    await vi.advanceTimersByTimeAsync(0);
    expect(b.settled).toBe(false);

    ws2.reply({ id: 'confirm', result: `0x${'bb'.repeat(32)}` });
    await vi.advanceTimersByTimeAsync(0);
    expect(b).toEqual({ settled: true, value: `0x${'bb'.repeat(32)}` });
  });

  it('recycles the connection without counting a failure after an aborted call, so its late error cannot reject the next', async () => {
    const socket = socketWith();
    const controller = new AbortController();
    const c = track(socket.call('confirm', { n: 'C' }, { timeoutMs: 5_000, signal: controller.signal }));
    const ws = await openLatest();
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.error).toBeInstanceOf(DOMException);

    const d = track(socket.call('confirm', { n: 'D' }, { timeoutMs: 30_000 }));
    expect(ws.sent).toHaveLength(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    wsAt(1).emit('error');
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    const ws3 = await openLatest();
    expect(ws3.frames()).toEqual([frame('confirm', { n: 'D' })]);

    ws.reply({ id: 'confirm', error: { code: -32000, message: 'quote expired' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(d.settled).toBe(false);

    ws3.reply({ id: 'confirm', result: 'D' });
    await vi.advanceTimersByTimeAsync(0);
    expect(d).toEqual({ settled: true, value: 'D' });
  });

  it('holds all sends while a call waits for a fresh connection and recycles once nothing is in flight', async () => {
    const socket = socketWith();
    const a = track(socket.call('confirm', { n: 'A' }, { timeoutMs: 1_000 }));
    const caps = track(socket.call('caps', {}, { timeoutMs: 10_000 }));
    const ws = await openLatest();
    await vi.advanceTimersByTimeAsync(500);
    expect(a.error).toBeInstanceOf(CallTimeoutError);

    const b = track(socket.call('confirm', { n: 'B' }, { timeoutMs: 10_000 }));
    const assets = track(socket.call('assets', {}, { timeoutMs: 10_000 }));
    expect(ws.frames()).toEqual([frame('confirm', { n: 'A' }), frame('caps', {})]);
    expect(FakeWebSocket.instances).toHaveLength(1);

    ws.reply({ id: 'caps', result: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(caps).toEqual({ settled: true, value: [] });
    expect(ws.closeCalls).toBe(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    const ws2 = await openLatest();
    expect(ws2.frames()).toEqual([frame('confirm', { n: 'B' }), frame('assets', {})]);
    expect(b.settled).toBe(false);
    expect(assets.settled).toBe(false);
  });

  it('rejects with sent false when the socket throws on send and drops the socket', async () => {
    const socket = socketWith();
    const assets = track(socket.call('assets', {}, { timeoutMs: 5_000 }));
    const ws = wsAt(0);
    ws.failSend = true;
    await openLatest();
    expect(assets.error).toBeInstanceOf(SocketClosedError);
    expect(assets.error).toMatchObject({ sent: false });
    expect(ws.closeCalls).toBe(1);
    expect(socket.state).toBe('closed');
  });

  it('calls onSent once, right after the frame is written, and never for a call that was not sent', async () => {
    const warn = vi.fn();
    const socket = socketWith({ logger: { debug: vi.fn(), warn } });
    const sentAt: number[] = [];
    const onSent = vi.fn(() => {
      sentAt.push(wsAt(0).sent.length);
    });
    const first = track(socket.call('request', { n: 1 }, { timeoutMs: 5_000, onSent }));
    const neverSent = vi.fn();
    const second = track(socket.call('request', { n: 2 }, { timeoutMs: 1_000, onSent: neverSent }));
    const throwing = () => {
      throw new Error('callback bug');
    };
    const caps = track(socket.call('caps', {}, { timeoutMs: 5_000, onSent: throwing }));
    expect(onSent).not.toHaveBeenCalled();

    const ws = await openLatest();
    expect(onSent).toHaveBeenCalledOnce();
    expect(sentAt).toEqual([1]);
    expect(warn).toHaveBeenCalledOnce();
    expect(ws.frames()).toEqual([frame('request', { n: 1 }), frame('caps', {})]);

    await vi.advanceTimersByTimeAsync(500);
    expect(second.error).toMatchObject({ sent: false });
    ws.reply({ id: 'request', result: 'one' });
    ws.reply({ id: 'caps', result: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(first).toEqual({ settled: true, value: 'one' });
    expect(caps).toEqual({ settled: true, value: [] });
    expect(onSent).toHaveBeenCalledOnce();
    expect(neverSent).not.toHaveBeenCalled();
  });

  it('logs and drops frames with id null, unknown ids or invalid JSON', async () => {
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const socket = socketWith({ logger });
    const assets = track(socket.call('assets', {}, { timeoutMs: 5_000 }));
    const ws = await openLatest();

    ws.reply({ id: null, error: { code: -32700, message: 'Parse error' } });
    ws.emit('message', 'not json');
    expect(logger.warn).toHaveBeenCalledTimes(2);
    ws.reply({ id: 'caps', result: [] });
    expect(logger.debug).toHaveBeenCalledWith({ id: 'caps' }, expect.any(String));
    await vi.advanceTimersByTimeAsync(0);
    expect(assets.settled).toBe(false);

    ws.reply({ id: 'assets', result: 'ok' });
    await vi.advanceTimersByTimeAsync(0);
    expect(assets).toEqual({ settled: true, value: 'ok' });
  });

  it('close() rejects pending and queued calls and closes the socket; only a later call reconnects', async () => {
    const socket = socketWith();
    const first = track(socket.call('request', { n: 1 }, { timeoutMs: 60_000 }));
    const second = track(socket.call('request', { n: 2 }, { timeoutMs: 60_000 }));
    const ws = await openLatest();

    socket.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(first.error).toBeInstanceOf(SocketClosedError);
    expect(first.error).toMatchObject({ sent: true });
    expect(second.error).toBeInstanceOf(SocketClosedError);
    expect(second.error).toMatchObject({ sent: false });
    expect(ws.closeCalls).toBe(1);
    expect(socket.state).toBe('closed');

    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);

    track(socket.call('caps', {}, { timeoutMs: 5_000 }));
    expect(FakeWebSocket.instances).toHaveLength(2);
    const ws2 = await openLatest();
    expect(ws2.frames()).toEqual([frame('caps', {})]);
  });
});
