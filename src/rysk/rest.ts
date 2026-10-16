import type { Address } from 'viem';
import { z } from 'zod';
import type { ConfirmBody, GasPreviewBody } from '../domain/index.ts';
import { isObject } from '../domain/parse.ts';
import { sleep as realSleep } from '../lib/time.ts';
import { CallTimeoutError, RestError } from './errors.ts';

export type GasResult =
  | { ok: true; gasFee6: bigint; echoed: Record<string, unknown> }
  | { ok: false; reason: 'exceeds-premium' | 'http'; status: number; message: string };

export type RyskRestOptions = {
  baseUrl: string;
  fetch?: typeof fetch;
  /** Per attempt, covering the response headers and body. */
  timeoutMs?: number;
  /** Retries after the first attempt, on network errors and 5xx only. */
  retries?: number;
  /** Called with `Date.parse` of every response's `Date` header (skew measurement). */
  onServerDate?: (serverMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 3;
const BACKOFF_BASE_MS = 100;
const BACKOFF_FACTOR = 5;
const BACKOFF_CAP_MS = 5_000;
const EXCEEDS_PREMIUM = /gas fee more than premium/i;

// `/api/gas` echoes the request plus `gasFee` (6-dp USD); `""` or absent means zero.
const gasResponse = z.looseObject({ gasFee: z.optional(z.string().regex(/^[0-9]*$/)) });

type HttpResult = { status: number; ok: boolean; text: string; date: string | null };

/** 100 ms, 500 ms, 2.5 s, then 5 s for every later retry. */
function backoffMs(retry: number): number {
  return Math.min(BACKOFF_BASE_MS * BACKOFF_FACTOR ** retry, BACKOFF_CAP_MS);
}

/** Settles with `promise`, or rejects with `signal.reason` when the signal aborts first. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function parseJson(response: HttpResult): unknown {
  try {
    return JSON.parse(response.text);
  } catch {
    throw new RestError(response.status, 'response is not JSON');
  }
}

/**
 * Rysk V12 REST API. GET methods return the raw parsed JSON for the domain parsers to type; `gasFee`
 * returns a `GasResult`. Network errors and 5xx are retried with backoff; 4xx and timeouts never are.
 */
export class RyskRest {
  readonly #baseUrl: URL;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #retries: number;
  readonly #onServerDate: (serverMs: number) => void;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(opts: RyskRestOptions) {
    this.#baseUrl = new URL(opts.baseUrl);
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#retries = opts.retries ?? DEFAULT_RETRIES;
    this.#onServerDate = opts.onServerDate ?? (() => {});
    this.#sleep = opts.sleep ?? ((ms) => realSleep(ms));
  }

  assets(): Promise<unknown> {
    return this.#getJson('/api/assets');
  }

  inventory(): Promise<unknown> {
    return this.#getJson('/api/inventory');
  }

  caps(): Promise<unknown> {
    return this.#getJson('/api/caps');
  }

  userPositions(address: Address): Promise<unknown> {
    return this.#getJson('/api/user/positions', { address });
  }

  publicHistory(fromSec: number, toSec: number): Promise<unknown> {
    return this.#getJson('/api/history', { from: String(fromSec), to: String(toSec) });
  }

  async gasFee(body: ConfirmBody | GasPreviewBody): Promise<GasResult> {
    const response = await this.#request('/api/gas', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const reason = EXCEEDS_PREMIUM.test(response.text) ? 'exceeds-premium' : 'http';
      return { ok: false, reason, status: response.status, message: response.text };
    }
    const json = parseJson(response);
    if (!isObject(json)) throw new RestError(response.status, 'gas response is not an object');
    const parsed = gasResponse.safeParse(json);
    if (!parsed.success) {
      const gasFee = JSON.stringify(json.gasFee);
      throw new RestError(response.status, `gas response gasFee is not a uint string: ${gasFee}`);
    }
    const echoed = parsed.data;
    return { ok: true, gasFee6: BigInt(echoed.gasFee || '0'), echoed };
  }

  async #getJson(path: string, query: Record<string, string> = {}): Promise<unknown> {
    const response = await this.#request(path, { method: 'GET' }, query);
    if (!response.ok) throw new RestError(response.status, response.text);
    return parseJson(response);
  }

  /** Returns the final response, 5xx included once the retries are spent; rethrows the last network error. */
  async #request(path: string, init: RequestInit, query: Record<string, string> = {}): Promise<HttpResult> {
    const url = new URL(path, this.#baseUrl);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    for (let retry = 0; ; retry++) {
      let response: HttpResult;
      try {
        response = await this.#attempt(url, init);
      } catch (error) {
        if (error instanceof CallTimeoutError || retry >= this.#retries) throw error;
        await this.#sleep(backoffMs(retry));
        continue;
      }
      this.#reportServerDate(response.date);
      if (response.status < 500 || retry >= this.#retries) return response;
      await this.#sleep(backoffMs(retry));
    }
  }

  async #attempt(url: URL, init: RequestInit): Promise<HttpResult> {
    const signal = AbortSignal.timeout(this.#timeoutMs);
    const exchange = async (): Promise<HttpResult> => {
      const response = await this.#fetch(url.toString(), { ...init, signal });
      const date = response.headers.get('date');
      return { status: response.status, ok: response.ok, text: await response.text(), date };
    };
    try {
      return await untilAborted(exchange(), signal);
    } catch (error) {
      if (!signal.aborted) throw error;
      const message = `${init.method} ${url.pathname} timed out after ${this.#timeoutMs} ms`;
      throw new CallTimeoutError(message, true, { cause: error });
    }
  }

  #reportServerDate(header: string | null): void {
    if (header === null) return;
    const serverMs = Date.parse(header);
    if (!Number.isNaN(serverMs)) this.#onServerDate(serverMs);
  }
}
