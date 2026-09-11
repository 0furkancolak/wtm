import { expect, test } from 'bun:test';
import { wtmConfigSchema } from '../schema';
import { resolveTask } from '../../runtime/task-resolver';

test('memory admission and per-task worker environment are explicit opt-ins', () => {
  const config = {
    jobs: { max_concurrent_heavy: 4, memory: { budget_mib: 8192, reserve_mib: 2048 } },
    tasks: { build: { run: ['cargo', 'build'], queue: true, timeout: '5m', memory_estimate_mib: 2048, queue_env: { CARGO_BUILD_JOBS: '2' } } },
  };
  expect(wtmConfigSchema.parse(config)).toEqual(config);
  expect(wtmConfigSchema.parse({ jobs: { max_concurrent_heavy: 1 } })).toEqual({ jobs: { max_concurrent_heavy: 1 } });
});

test('rejects invalid memory quantities and queue-only worker settings on a foreground task', () => {
  for (const value of [0, -1, 0.5, Number.MAX_SAFE_INTEGER]) {
    expect(wtmConfigSchema.safeParse({ jobs: { memory: { budget_mib: value } } }).success).toBe(false);
    expect(wtmConfigSchema.safeParse({ tasks: { x: { run: ['test'], memory_estimate_mib: value } } }).success).toBe(false);
  }
  expect(wtmConfigSchema.safeParse({ tasks: { x: { run: ['test'], queue_env: { WORKERS: '1' } } } }).success).toBe(false);
  expect(wtmConfigSchema.safeParse({ jobs: { memory: { budget_mib: 1, reserve_mib: -1 } } }).success).toBe(false);
});

test('queued worker environment uses task templates without changing foreground resolution', () => {
  const input = {
    config: { tasks: { build: { run: ['tool', '--workers', '{env.WORKERS}'], queue: true, timeout: '1m', env: { WORKERS: '8' }, queue_env: { WORKERS: '2', URL: 'http://localhost:{port.web}' } } } },
    taskName: 'build', isMain: false, context: { worktree: { root: '/repo' }, ports: { web: 4000 } },
  };
  const queued = resolveTask({ ...input, executionMode: 'queued' });
  expect(queued.argv).toEqual(['tool', '--workers', '2']);
  expect(queued.envDelta).toEqual({ WORKERS: '2', URL: 'http://localhost:4000' });
  expect(resolveTask(input).argv).toEqual(['tool', '--workers', '8']);
  expect(resolveTask(input).envDelta).toEqual({ WORKERS: '8' });
});
