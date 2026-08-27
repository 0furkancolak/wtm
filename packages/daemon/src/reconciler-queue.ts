export type ReconcileSignalKind = 'config' | 'fingerprint' | 'git-topology' | 'manifest' | 'watch-error';

export interface ReconcileSignal {
  root: string;
  kind: ReconcileSignalKind;
}

export interface ReconcileBatch {
  roots: string[];
  kinds: ReconcileSignalKind[];
}

export interface ReconcilerClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ReconcilerQueueOptions {
  run(batch: ReconcileBatch): Promise<void> | void;
  debounceMs?: number;
  maxCoalesceMs?: number;
  clock?: ReconcilerClock;
  onError?: (error: unknown) => void;
}

const systemClock: ReconcilerClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class ReconcilerQueue {
  readonly #run: ReconcilerQueueOptions['run'];
  readonly #debounceMs: number;
  readonly #maxCoalesceMs: number;
  readonly #clock: ReconcilerClock;
  readonly #onError: (error: unknown) => void;
  readonly #roots = new Set<string>();
  readonly #kinds = new Set<ReconcileSignalKind>();
  readonly #idleWaiters = new Set<() => void>();
  #firstSignalAt: number | null = null;
  #timer: unknown = null;
  #running: Promise<void> | null = null;
  #flushPromise: Promise<void> | null = null;
  #closePromise: Promise<void> | null = null;
  #pendingError: unknown;
  #hasPendingError = false;
  #state: 'open' | 'closing' | 'closed' = 'open';
  #generation = 0;

  constructor(options: ReconcilerQueueOptions) {
    this.#run = options.run;
    this.#debounceMs = options.debounceMs ?? 200;
    this.#maxCoalesceMs = options.maxCoalesceMs ?? 1_000;
    this.#clock = options.clock ?? systemClock;
    this.#onError = options.onError ?? (() => {});
    if (!Number.isInteger(this.#debounceMs) || this.#debounceMs < 0) {
      throw new RangeError('Reconciliation debounce must be a non-negative integer');
    }
    if (!Number.isInteger(this.#maxCoalesceMs) || this.#maxCoalesceMs < this.#debounceMs) {
      throw new RangeError('Maximum coalesce window must be an integer at least as large as debounce');
    }
  }

  schedule(signal: ReconcileSignal): void {
    if (this.#state !== 'open') return;
    this.#generation += 1;
    this.#roots.add(signal.root);
    this.#kinds.add(signal.kind);
    const now = this.#clock.now();
    this.#firstSignalAt ??= now;
    if (this.#running !== null) return;
    this.#arm(Math.min(now + this.#debounceMs, this.#firstSignalAt + this.#maxCoalesceMs) - now);
  }

  get generation(): number {
    return this.#generation;
  }

  get idle(): boolean {
    return this.#isIdle();
  }

  flush(): Promise<void> {
    if (this.#flushPromise !== null) return this.#flushPromise;
    this.#flushPromise = this.#flush().finally(() => { this.#flushPromise = null; });
    return this.#flushPromise;
  }

  async #flush(): Promise<void> {
    this.#cancelTimer();
    while (this.#running !== null || this.#roots.size > 0) {
      if (this.#running !== null) await this.#running;
      if (this.#roots.size > 0) await this.#drain();
    }
    this.#resolveIdle();
    if (this.#hasPendingError) {
      const error = this.#pendingError;
      this.#pendingError = undefined;
      this.#hasPendingError = false;
      throw error;
    }
  }

  async whenIdle(): Promise<void> {
    if (this.#isIdle()) return;
    await new Promise<void>((resolve) => this.#idleWaiters.add(resolve));
  }

  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    if (this.#state === 'closed') return Promise.resolve();
    this.#state = 'closing';
    this.#cancelTimer();
    this.#closePromise = this.flush().finally(() => {
      this.#state = 'closed';
      this.#closePromise = null;
    });
    return this.#closePromise;
  }

  #arm(delayMs: number): void {
    this.#cancelTimer();
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = null;
      void this.#drain().catch((error: unknown) => this.#recordError(error));
    }, Math.max(0, delayMs));
  }

  #cancelTimer(): void {
    if (this.#timer === null) return;
    this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
  }

  async #drain(): Promise<void> {
    if (this.#running !== null) return this.#running;
    if (this.#roots.size === 0) {
      this.#resolveIdle();
      return;
    }
    const batch: ReconcileBatch = {
      roots: [...this.#roots].sort(),
      kinds: [...this.#kinds].sort(),
    };
    this.#roots.clear();
    this.#kinds.clear();
    this.#firstSignalAt = null;
    const run = Promise.resolve()
      .then(() => this.#run(batch))
      .catch((error: unknown) => this.#recordError(error));
    this.#running = run;
    await run;
    if (this.#running === run) this.#running = null;
    if (this.#roots.size > 0 && this.#firstSignalAt !== null) {
      const now = this.#clock.now();
      this.#arm(Math.min(now + this.#debounceMs, this.#firstSignalAt + this.#maxCoalesceMs) - now);
    } else {
      this.#resolveIdle();
    }
  }

  #isIdle(): boolean {
    return this.#timer === null && this.#running === null && this.#roots.size === 0;
  }

  #resolveIdle(): void {
    if (!this.#isIdle()) return;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }

  #recordError(error: unknown): void {
    if (!this.#hasPendingError) {
      this.#pendingError = error;
      this.#hasPendingError = true;
    }
    try {
      this.#onError(error);
    } catch {
      // Observer failures cannot break queue cleanup or become unhandled rejections.
    }
  }
}
