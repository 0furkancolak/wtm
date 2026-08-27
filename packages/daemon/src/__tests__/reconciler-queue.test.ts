import { describe, expect, test } from 'bun:test';

const queueModule = await import('../reconciler-queue').catch(() => null);

interface TimerEntry {
  id: number;
  due: number;
  callback: () => void;
}

class ManualClock {
  nowMs = 0;
  nextId = 1;
  timers = new Map<number, TimerEntry>();

  readonly now = () => this.nowMs;
  readonly setTimeout = (callback: () => void, delayMs: number) => {
    const id = this.nextId++;
    this.timers.set(id, { id, due: this.nowMs + delayMs, callback });
    return id;
  };
  readonly clearTimeout = (id: unknown) => {
    this.timers.delete(id as number);
  };

  advance(ms: number): void {
    const target = this.nowMs + ms;
    while (true) {
      const next = [...this.timers.values()]
        .filter(({ due }) => due <= target)
        .sort((left, right) => left.due - right.due || left.id - right.id)[0];
      if (next === undefined) break;
      this.nowMs = next.due;
      this.timers.delete(next.id);
      next.callback();
    }
    this.nowMs = target;
  }
}

describe('ReconcilerQueue', () => {
  test('debounces a burst for 200ms', async () => {
    expect(queueModule).not.toBeNull();
    if (queueModule === null) return;
    const clock = new ManualClock();
    const batches: unknown[] = [];
    const queue = new queueModule.ReconcilerQueue({
      run: async (batch) => { batches.push(batch); },
      clock,
    });

    queue.schedule({ root: '/workspace', kind: 'git-topology' });
    clock.advance(199);
    await Promise.resolve();
    expect(batches).toHaveLength(0);
    clock.advance(1);
    await queue.whenIdle();
    expect(batches).toHaveLength(1);
  });

  test('runs no later than the 1000ms maximum coalesce window', async () => {
    expect(queueModule).not.toBeNull();
    if (queueModule === null) return;
    const clock = new ManualClock();
    const runAt: number[] = [];
    const queue = new queueModule.ReconcilerQueue({
      run: async () => { runAt.push(clock.now()); },
      clock,
    });

    queue.schedule({ root: '/workspace', kind: 'manifest' });
    for (let elapsed = 100; elapsed <= 900; elapsed += 100) {
      clock.advance(100);
      queue.schedule({ root: '/workspace', kind: 'manifest' });
    }
    expect(runAt).toEqual([]);
    clock.advance(100);
    await queue.whenIdle();
    expect(runAt).toEqual([1000]);
  });

  test('flushes coalesced signal kinds as one deterministic batch', async () => {
    expect(queueModule).not.toBeNull();
    if (queueModule === null) return;
    const clock = new ManualClock();
    const batches: Array<{ roots: string[]; kinds: string[] }> = [];
    const queue = new queueModule.ReconcilerQueue({
      run: async (batch) => { batches.push(batch); },
      clock,
    });
    queue.schedule({ root: '/zeta', kind: 'manifest' });
    queue.schedule({ root: '/alpha', kind: 'git-topology' });
    queue.schedule({ root: '/zeta', kind: 'config' });

    await queue.flush();

    expect(batches).toEqual([{
      roots: ['/alpha', '/zeta'],
      kinds: ['config', 'git-topology', 'manifest'],
    }]);
  });

  test('gates scheduling before awaiting an in-flight close and never runs a post-close batch', async () => {
    expect(queueModule).not.toBeNull();
    if (queueModule === null) return;
    const clock = new ManualClock();
    const batches: unknown[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const queue = new queueModule.ReconcilerQueue({
      run: async (batch: unknown) => {
        batches.push(batch);
        await blocked;
      },
      clock,
    });
    queue.schedule({ root: '/first', kind: 'git-topology' });
    const flushing = queue.flush();
    await Promise.resolve();

    const closing = queue.close();
    queue.schedule({ root: '/late', kind: 'manifest' });
    release();
    await Promise.all([flushing, closing]);
    clock.advance(2_000);

    expect(batches).toHaveLength(1);
  });

  test('contains a throwing error observer, propagates the run failure, and accepts a later batch', async () => {
    expect(queueModule).not.toBeNull();
    if (queueModule === null) return;
    const clock = new ManualClock();
    let attempts = 0;
    const queue = new queueModule.ReconcilerQueue({
      run: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('reconcile failed');
      },
      onError: () => { throw new Error('observer failed'); },
      clock,
    });
    queue.schedule({ root: '/first', kind: 'git-topology' });

    await expect(queue.flush()).rejects.toThrow('reconcile failed');
    queue.schedule({ root: '/second', kind: 'manifest' });
    await queue.flush();

    expect(attempts).toBe(2);
    await queue.close();
  });
});
