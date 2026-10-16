import type { Clock } from '../lib/time.ts';

const MINUTE_MS = 60_000;

/** Spec §8.7: every strategy and sampler RFQ also takes a token from this shared limit (a sustained rate). */
export const HARD_CAP_RFQ_PER_MIN = 20;
/**
 * The part of the hard cap the strategy and sampler rates leave free (a config rule) for execution re-quotes, which are
 * sent without a token. There is at most one per execution, and executions are few: they run one at a time, each after
 * its own RFQ round trip and gas preview; a side whose confirm was sent waits for its reply (up to `confirmTimeoutMs`)
 * and then cools down, and one that aborted before the confirm backs its key off. `tickSeconds` alone (5 s at least)
 * does not bound them.
 */
export const REQUOTE_RESERVE_RFQ_PER_MIN = 2;

/**
 * An RFQ rate limit (spec §8.7): `perMinute` tokens of capacity, starting full, refilled continuously at
 * `perMinute / 60` a second on `clock`. Credit is kept in token-milliseconds (`MINUTE_MS` of them per token), so
 * whole-millisecond clocks and whole-number rates refill in integers and 6 a minute grants exactly one token
 * every 10 s. Time the clock goes back earns nothing until it has caught up again.
 */
export class TokenBucket {
  readonly #perMinute: number;
  readonly #clock: Clock;
  readonly #capacity: number;
  #credit: number;
  #lastMs: number;

  constructor(perMinute: number, clock: Clock) {
    if (!Number.isFinite(perMinute) || perMinute <= 0) {
      throw new RangeError(
        `token bucket rate must be a positive number of tokens a minute, not ${perMinute}`,
      );
    }
    this.#perMinute = perMinute;
    this.#clock = clock;
    this.#capacity = perMinute * MINUTE_MS;
    this.#credit = this.#capacity;
    this.#lastMs = clock.nowMs();
  }

  /** Spends one token if a whole one is available. */
  take(): boolean {
    this.#refill();
    if (this.#credit < MINUTE_MS) return false;
    this.#credit -= MINUTE_MS;
    return true;
  }

  /** Milliseconds until a whole token is available; 0 when one is now. */
  waitMs(): number {
    this.#refill();
    return this.#credit >= MINUTE_MS ? 0 : Math.ceil((MINUTE_MS - this.#credit) / this.#perMinute);
  }

  #refill(): void {
    const nowMs = this.#clock.nowMs();
    const elapsedMs = Math.max(0, nowMs - this.#lastMs);
    this.#credit = Math.min(this.#capacity, this.#credit + elapsedMs * this.#perMinute);
    this.#lastMs = Math.max(this.#lastMs, nowMs);
  }
}

/** What an RFQ loop takes tokens from: one `TokenBucket`, or several combined. */
export type RfqBucket = Pick<TokenBucket, 'take' | 'waitMs'>;

/**
 * Several limits as one (spec §8.7: a loop's own rate and the shared hard cap): `take()` grants a token only when
 * every bucket has one, and then takes one from each, so a denial consumes nothing; `waitMs()` is the longest wait.
 */
export function combinedBucket(...buckets: RfqBucket[]): RfqBucket {
  return {
    take: () => {
      if (buckets.some((bucket) => bucket.waitMs() > 0)) return false;
      return buckets.map((bucket) => bucket.take()).every(Boolean);
    },
    waitMs: () => Math.max(0, ...buckets.map((bucket) => bucket.waitMs())),
  };
}
