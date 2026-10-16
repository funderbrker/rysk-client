const DEFAULT_INTERVAL_MS = 3_600_000;
/** Per poll, so a hung request never stalls `start()` (and with it the daemon's startup). */
const REQUEST_TIMEOUT_MS = 15_000;

export type FrontendVersionWatcherOptions = {
  /** The web app's origin; the watcher polls `${appUrl}/api/version/`, which returns `{ sha, timestamp }`. */
  appUrl: string;
  fetch: typeof fetch;
  intervalMs?: number;
  /** Called with the error of every failed poll. */
  onError?: (error: unknown) => void;
};

/**
 * The frontend version tripwire (spec §9.5). `start()` polls once and resolves after that poll, whether it
 * succeeded or not, then polls every `intervalMs` on an unref'd timer. The first successful poll's `sha` is the
 * baseline; `changed` latches to true once a later successful poll returns a different `sha`. A failed poll
 * (network error, non-2xx status, a body without a non-empty string `sha`) changes nothing and goes to
 * `onError`. `sha` is the most recent successfully fetched sha, null before the first success.
 */
export class FrontendVersionWatcher {
  readonly #url: string;
  readonly #fetch: typeof fetch;
  readonly #intervalMs: number;
  readonly #onError: ((error: unknown) => void) | undefined;
  #baseline: string | null = null;
  #sha: string | null = null;
  #changed = false;
  #stopped = false;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: FrontendVersionWatcherOptions) {
    this.#url = `${opts.appUrl.replace(/\/+$/, '')}/api/version/`;
    this.#fetch = opts.fetch;
    this.#intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#onError = opts.onError;
  }

  get changed(): boolean {
    return this.#changed;
  }

  get sha(): string | null {
    return this.#sha;
  }

  async start(): Promise<void> {
    await this.#poll();
    if (this.#stopped) return;
    this.#timer = setInterval(() => void this.#poll(), this.#intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async #poll(): Promise<void> {
    let sha: string;
    try {
      sha = await this.#fetchSha();
    } catch (error) {
      this.#onError?.(error);
      return;
    }
    if (this.#baseline === null) this.#baseline = sha;
    else if (sha !== this.#baseline) this.#changed = true;
    this.#sha = sha;
  }

  async #fetchSha(): Promise<string> {
    const response = await this.#fetch(this.#url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`GET ${this.#url}: HTTP ${response.status}`);
    const body: unknown = await response.json();
    const sha = typeof body === 'object' && body !== null ? (body as { sha?: unknown }).sha : undefined;
    if (typeof sha !== 'string' || sha === '') throw new Error(`GET ${this.#url}: no sha in the response`);
    return sha;
  }
}
