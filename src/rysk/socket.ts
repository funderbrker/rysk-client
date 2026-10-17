import { isObject } from '../domain/parse.ts';
import { CallTimeoutError, RyskRpcError, SocketClosedError } from './errors.ts';

export type WebSocketLike = Pick<WebSocket, 'send' | 'close' | 'readyState' | 'addEventListener'>;

/** Pino-compatible. */
type Logger = { debug(obj: object, msg: string): void; warn(obj: object, msg: string): void };

export type SocketOptions = {
  url: string;
  createWebSocket?: (url: string) => WebSocketLike;
  /** From creating the socket to its `open` event. */
  connectTimeoutMs?: number;
  /** Close the socket after this long with nothing pending or queued. */
  idleCloseMs?: number;
  /** The connection is declared open, and calls are sent, this long after `open`. */
  openSettleMs?: number;
  /** Reconnect delay after n consecutive failures: `min(capMs, baseMs × 2ⁿ) × (1 ± jitter)`. */
  backoff?: { baseMs: number; capMs: number; jitter: number };
  /** Uniform in [0, 1); drives the jitter. */
  random?: () => number;
  logger?: Logger;
};

export type CallOptions = {
  /** Covers queue wait, connect and reply. */
  timeoutMs: number;
  /**
   * Replies whose `result` fails this are ignored and waiting continues (a late reply shares the id); so is one
   * `error` reply while a sent call of the method was abandoned unanswered on the connection, since an error
   * names no terms to match. A call without it is never sent on such a connection.
   */
  accept?: (result: unknown) => boolean;
  signal?: AbortSignal;
  /** Called synchronously right after the frame is written to the socket; never for an unsent call. */
  onSent?: () => void;
};

type SocketState = 'idle' | 'connecting' | 'open' | 'closed';

type Call = {
  readonly method: string;
  readonly frame: string;
  readonly accept: ((result: unknown) => boolean) | undefined;
  readonly onSent: (() => void) | undefined;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: unknown) => void;
  /** Clears the deadline and the abort listener. */
  cleanup: () => void;
};

type Timer = ReturnType<typeof setTimeout>;

const NO_LOGGER: Logger = { debug: () => {}, warn: () => {} };
const DEFAULT_BACKOFF = { baseMs: 1_000, capMs: 30_000, jitter: 0.25 };

/** A malformed `error` member still rejects: code 0, the raw JSON as the message. */
function rpcError(error: unknown): RyskRpcError {
  const code = isObject(error) && typeof error.code === 'number' ? error.code : 0;
  const message =
    isObject(error) && typeof error.message === 'string' ? error.message : JSON.stringify(error);
  return new RyskRpcError(code, message);
}

function parseFrame(data: unknown): Record<string, unknown> | undefined {
  if (typeof data !== 'string') return undefined;
  try {
    const frame: unknown = JSON.parse(data);
    return isObject(frame) ? frame : undefined;
  } catch {
    return undefined;
  }
}

/**
 * JSON-RPC 2.0 over one on-demand WebSocket to the Rysk `/taker` endpoint. Every frame's `id` is its method
 * name, so calls are serialized per method: a method's next call is sent once the previous one settles,
 * while different methods interleave. No heartbeat: per-call deadlines detect a dead connection, and the
 * socket closes after `idleCloseMs` with nothing to do. Calls are never retried.
 */
export class JsonRpcSocket {
  readonly #url: string;
  readonly #createWebSocket: (url: string) => WebSocketLike;
  readonly #connectTimeoutMs: number;
  readonly #idleCloseMs: number;
  readonly #openSettleMs: number;
  readonly #backoff: { baseMs: number; capMs: number; jitter: number };
  readonly #random: () => number;
  readonly #logger: Logger;

  #state: SocketState = 'idle';
  #current: WebSocketLike | null = null;
  #connectionId = 0;
  #failures = 0;
  /** `performance.now()` before which no new socket is created. */
  #retryAtMs = 0;
  #reconnectTimer: Timer | undefined;
  #connectTimer: Timer | undefined;
  #settleTimer: Timer | undefined;
  #idleTimer: Timer | undefined;
  /** Unsent calls per method, FIFO. */
  readonly #queues = new Map<string, Call[]>();
  /** The sent, unsettled call per method. */
  readonly #inFlight = new Map<string, Call>();
  /**
   * Methods whose sent call timed out or was aborted on the current connection: its reply may still arrive
   * and would match the method's next call. Cleared when a new connection is declared open.
   */
  readonly #unanswered = new Set<string>();

  constructor(opts: SocketOptions) {
    this.#url = opts.url;
    this.#createWebSocket = opts.createWebSocket ?? ((url) => new WebSocket(url));
    this.#connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
    this.#idleCloseMs = opts.idleCloseMs ?? 30_000;
    this.#openSettleMs = opts.openSettleMs ?? 500;
    this.#backoff = opts.backoff ?? DEFAULT_BACKOFF;
    this.#random = opts.random ?? Math.random;
    this.#logger = opts.logger ?? NO_LOGGER;
  }

  get state(): SocketState {
    return this.#state;
  }

  /** Incremented each time a connection is declared open; 0 before the first. */
  get connectionId(): number {
    return this.#connectionId;
  }

  /**
   * Resolves with the reply's `result`. Rejects with `RyskRpcError` on an `error` reply, `SocketClosedError`
   * when the socket closes after sending (or on `close()`), `CallTimeoutError` at the deadline, or the
   * signal's reason on abort. Both error classes say whether the frame was `sent`.
   */
  call<T>(method: string, params: unknown, opts: CallOptions): Promise<T> {
    const { timeoutMs, accept, signal, onSent } = opts;
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error('aborted'));
        return;
      }
      const call: Call = {
        method,
        frame: JSON.stringify({ jsonrpc: '2.0', method, id: method, params }),
        accept,
        onSent,
        resolve: (result) => resolve(result as T),
        reject,
        cleanup: () => {},
      };
      const timer = setTimeout(() => {
        const sent = this.#inFlight.get(method) === call;
        const what = sent ? 'got no reply' : 'was not sent';
        this.#abandon(call, new CallTimeoutError(`${method} ${what} within ${timeoutMs} ms`, sent));
      }, timeoutMs);
      const onAbort = (): void => this.#abandon(call, signal?.reason ?? new Error('aborted'));
      signal?.addEventListener('abort', onAbort, { once: true });
      call.cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      this.#queues.set(method, [...(this.#queues.get(method) ?? []), call]);
      this.#drive();
    });
  }

  /** Closes the socket and rejects every pending and queued call with `SocketClosedError`. */
  close(): void {
    this.#clearTimers();
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    const ws = this.#current;
    this.#current = null;
    this.#state = 'closed';
    const inFlight = [...this.#inFlight.values()];
    const queued = [...this.#queues.values()].flat();
    this.#inFlight.clear();
    this.#queues.clear();
    const reject = (call: Call, sent: boolean): void => {
      call.cleanup();
      call.reject(new SocketClosedError(`${call.method}: socket closed by the client`, sent));
    };
    for (const call of inFlight) reject(call, true);
    for (const call of queued) reject(call, false);
    ws?.close();
  }

  /**
   * Sends what can be sent, connects when calls wait for a socket, and arms or clears the idle close. While a
   * queued call needs a fresh connection nothing more is sent, and the connection is recycled once idle.
   */
  #drive(): void {
    const ws = this.#current;
    if (this.#state === 'open' && ws !== null) {
      if (this.#needsFreshConnection()) {
        if (this.#inFlight.size === 0) this.#recycle(ws);
      } else {
        for (const method of [...this.#queues.keys()]) {
          if (this.#state !== 'open') break;
          if (!this.#inFlight.has(method)) this.#sendNext(method);
        }
      }
    } else if (this.#queues.size > 0 && this.#current === null && this.#reconnectTimer === undefined) {
      this.#scheduleConnect(this.#retryAtMs - performance.now());
    }
    this.#updateIdleTimer();
  }

  /** A queue's next call has no `accept` and a sent call of its method went unanswered on this connection. */
  #needsFreshConnection(): boolean {
    for (const method of this.#unanswered) {
      const next = this.#queues.get(method)?.[0];
      if (next !== undefined && next.accept === undefined) return true;
    }
    return false;
  }

  #sendNext(method: string): void {
    const ws = this.#current;
    const queue = this.#queues.get(method);
    const call = queue?.shift();
    if (ws === null || queue === undefined || call === undefined) return;
    if (queue.length === 0) this.#queues.delete(method);
    this.#inFlight.set(method, call);
    try {
      ws.send(call.frame);
    } catch (error) {
      this.#inFlight.delete(method);
      call.cleanup();
      call.reject(new SocketClosedError(`${method}: socket send failed`, false, { cause: error }));
      this.#logger.warn({ err: error, method }, 'rysk ws send failed');
      this.#drop(ws, 'send failed');
      return;
    }
    this.#logger.debug({ method, connectionId: this.#connectionId }, 'rysk ws sent');
    try {
      call.onSent?.();
    } catch (error) {
      this.#logger.warn({ err: error, method }, 'rysk ws onSent threw');
    }
  }

  /** Replaces a connection that may still deliver a stale reply. Not a failure: no backoff. */
  #recycle(ws: WebSocketLike): void {
    this.#current = null;
    this.#state = 'closed';
    this.#clearTimers();
    const unanswered = [...this.#unanswered];
    this.#logger.debug({ connectionId: this.#connectionId, unanswered }, 'rysk ws recycling the connection');
    ws.close();
    this.#connect();
  }

  #scheduleConnect(waitMs: number): void {
    if (waitMs <= 0) this.#connect();
    else this.#armReconnect(waitMs);
  }

  /** Connects after `waitMs` if calls are still queued by then. */
  #armReconnect(waitMs: number): void {
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      if (this.#queues.size > 0) this.#connect();
    }, waitMs);
  }

  #connect(): void {
    let ws: WebSocketLike;
    try {
      ws = this.#createWebSocket(this.#url);
    } catch (error) {
      this.#state = 'closed';
      const retryInMs = this.#backOff();
      this.#logger.warn({ err: error, url: this.#url, retryInMs }, 'rysk ws could not be created');
      this.#armReconnect(retryInMs);
      return;
    }
    this.#current = ws;
    this.#state = 'connecting';
    this.#logger.debug({ url: this.#url }, 'rysk ws connecting');
    this.#connectTimer = setTimeout(() => this.#drop(ws, 'connect timeout'), this.#connectTimeoutMs);
    ws.addEventListener('open', () => {
      if (ws !== this.#current) return;
      clearTimeout(this.#connectTimer);
      this.#connectTimer = undefined;
      this.#settleTimer = setTimeout(() => this.#declareOpen(ws), this.#openSettleMs);
    });
    ws.addEventListener('message', (event) => {
      if (ws === this.#current) this.#onMessage(event.data);
    });
    ws.addEventListener('close', (event) =>
      this.#drop(ws, 'closed', { code: event.code, reason: event.reason }),
    );
    ws.addEventListener('error', () => this.#drop(ws, 'error'));
  }

  #declareOpen(ws: WebSocketLike): void {
    if (ws !== this.#current) return;
    this.#settleTimer = undefined;
    this.#state = 'open';
    this.#failures = 0;
    this.#connectionId += 1;
    this.#unanswered.clear();
    this.#logger.debug({ connectionId: this.#connectionId }, 'rysk ws open');
    this.#drive();
  }

  /** Forgets `ws` (closing it unless it closed itself), rejects its in-flight calls and backs off. */
  #drop(ws: WebSocketLike, why: string, details: { code?: number; reason?: string } = {}): void {
    if (ws !== this.#current) return;
    this.#current = null;
    this.#state = 'closed';
    this.#clearTimers();
    const retryInMs = this.#backOff();
    this.#logger.warn({ ...details, why, connectionId: this.#connectionId, retryInMs }, 'rysk ws dropped');
    if (why !== 'closed') ws.close();
    const calls = [...this.#inFlight.values()];
    this.#inFlight.clear();
    for (const call of calls) {
      call.cleanup();
      call.reject(new SocketClosedError(`${call.method}: socket ${why} before the reply`, true));
    }
    this.#drive();
  }

  /** Records a failure and returns the delay before the next socket may be created. */
  #backOff(): number {
    const { baseMs, capMs, jitter } = this.#backoff;
    const spread = 1 + jitter * (2 * this.#random() - 1);
    const delayMs = Math.round(Math.min(capMs, baseMs * 2 ** this.#failures) * spread);
    this.#failures += 1;
    this.#retryAtMs = performance.now() + delayMs;
    return delayMs;
  }

  #onMessage(data: unknown): void {
    const frame = parseFrame(data);
    if (frame === undefined) {
      this.#logger.warn(
        { data: String(data).slice(0, 200) },
        'rysk ws dropped a frame that is not a JSON object',
      );
      return;
    }
    const { id } = frame;
    if (typeof id !== 'string') {
      this.#logger.warn({ frame }, 'rysk ws dropped a frame without a call id');
      return;
    }
    const call = this.#inFlight.get(id);
    if (call === undefined) {
      this.#logger.debug({ id }, 'rysk ws dropped a reply with no pending call');
      return;
    }
    if (frame.error !== undefined && frame.error !== null) {
      // A result names the terms `accept` matches; an error names nothing. While a sent call of this method
      // was abandoned unanswered on this connection, one error reply is taken as that call's late answer.
      if (call.accept !== undefined && this.#unanswered.delete(id)) {
        this.#logger.debug({ id, error: frame.error }, 'rysk ws ignored an error reply to an abandoned call');
        return;
      }
      this.#reject(call, rpcError(frame.error));
      return;
    }
    if (!('result' in frame)) {
      this.#logger.warn({ id }, 'rysk ws dropped a reply with neither result nor error');
      return;
    }
    if (call.accept !== undefined && !this.#accepts(call.accept, id, frame.result)) {
      // The late reply to the abandoned call, if there was one, has now come.
      this.#unanswered.delete(id);
      return;
    }
    if (this.#detach(call)) call.resolve(frame.result);
    this.#drive();
  }

  #accepts(accept: (result: unknown) => boolean, id: string, result: unknown): boolean {
    try {
      if (accept(result)) return true;
      this.#logger.debug({ id }, 'rysk ws ignored a reply that failed accept');
    } catch (error) {
      this.#logger.warn({ err: error, id }, 'rysk ws ignored a reply whose accept threw');
    }
    return false;
  }

  /** Settles `call` without its reply. If it was sent, the reply may still come, so its method is marked. */
  #abandon(call: Call, error: unknown): void {
    if (this.#inFlight.get(call.method) === call) this.#unanswered.add(call.method);
    this.#reject(call, error);
  }

  #reject(call: Call, error: unknown): void {
    if (this.#detach(call)) call.reject(error);
    this.#drive();
  }

  /** Removes `call` from the in-flight map or its queue; false when it already settled. */
  #detach(call: Call): boolean {
    if (this.#inFlight.get(call.method) === call) {
      this.#inFlight.delete(call.method);
    } else {
      const queue = this.#queues.get(call.method) ?? [];
      const index = queue.indexOf(call);
      if (index < 0) return false;
      queue.splice(index, 1);
      if (queue.length === 0) this.#queues.delete(call.method);
    }
    call.cleanup();
    return true;
  }

  #updateIdleTimer(): void {
    const busy = this.#inFlight.size > 0 || this.#queues.size > 0;
    if (busy || this.#state !== 'open') {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    } else if (this.#idleTimer === undefined) {
      this.#idleTimer = setTimeout(() => this.#closeIdle(), this.#idleCloseMs);
    }
  }

  #closeIdle(): void {
    this.#idleTimer = undefined;
    const ws = this.#current;
    if (ws === null) return;
    this.#current = null;
    this.#state = 'idle';
    this.#logger.debug({ connectionId: this.#connectionId }, 'rysk ws closed while idle');
    ws.close();
  }

  #clearTimers(): void {
    clearTimeout(this.#connectTimer);
    clearTimeout(this.#settleTimer);
    clearTimeout(this.#idleTimer);
    this.#connectTimer = undefined;
    this.#settleTimer = undefined;
    this.#idleTimer = undefined;
  }
}
