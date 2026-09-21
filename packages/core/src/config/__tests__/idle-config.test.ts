import { expect, test } from 'bun:test';
import { wtmConfigSchema } from '../schema';
import { idlePolicies, taskIdlePolicy } from '../idle';
import { idleTimeoutMs } from '../task-timeout';

test('idle suspension is a per-task opt-in with an explicit window', () => {
  const config = {
    tasks: { dev: { run: ['pnpm', 'dev'], idle: { enabled: true, timeout: '30m' } } },
  };
  expect(wtmConfigSchema.parse(config)).toEqual(config);
  // Written and left off: accepted, and carries no policy.
  const off = { tasks: { dev: { run: ['pnpm', 'dev'], idle: { enabled: false, timeout: '30m' } } } };
  expect(wtmConfigSchema.parse(off)).toEqual(off);
  expect(idlePolicies(off).size).toBe(0);
  // The default is off, which is what "no idle table" has to keep meaning.
  expect(idlePolicies({ tasks: { dev: { } } }).size).toBe(0);
  expect(idlePolicies({}).size).toBe(0);
});

test('an enabled idle block requires a window, and a queued task may not have one at all', () => {
  const rejected = [
    { tasks: { dev: { run: ['pnpm', 'dev'], idle: { enabled: true } } } },
    { tasks: { dev: { run: ['pnpm', 'dev'], idle: { enabled: true, timeout: '0s' } } } },
    { tasks: { dev: { run: ['pnpm', 'dev'], idle: { enabled: true, timeout: '30' } } } },
    { tasks: { dev: { run: ['pnpm', 'dev'], idle: { enabled: true, timeout: '25h' } } } },
    { tasks: { dev: { run: ['pnpm', 'dev'], idle: { enabled: true, timeout: '500ms' } } } },
    { tasks: { dev: { run: ['pnpm', 'dev'], idle: { timeout: 'soon' } } } },
    { tasks: { dev: { run: ['pnpm', 'dev'], idle: { enabled: true, timeout: '30m', grace: '1m' } } } },
    // A queued task ends inside its own finite timeout and is not a `wtm start` process, so an
    // idle window on one is refused however it is written.
    { tasks: { build: { run: ['make'], queue: true, timeout: '10m', idle: { enabled: true, timeout: '30m' } } } },
    { tasks: { build: { run: ['make'], queue: true, timeout: '10m', idle: { enabled: false } } } },
  ];
  for (const config of rejected) expect(wtmConfigSchema.safeParse(config).success).toBe(false);
});

test('a resolved policy carries the configured text, and refuses a queued task a second time', () => {
  expect(taskIdlePolicy({ idle: { enabled: true, timeout: '30m' } })).toEqual({ timeoutMs: 1_800_000, timeout: '30m' });
  expect(taskIdlePolicy({ idle: { enabled: true, timeout: '30m' }, queue: true })).toBeNull();
  expect(taskIdlePolicy({ idle: { enabled: true } })).toBeNull();
  expect(taskIdlePolicy({ idle: { timeout: '30m' } })).toBeNull();
  expect(taskIdlePolicy(undefined)).toBeNull();
  expect(idlePolicies({
    tasks: {
      dev: { idle: { enabled: true, timeout: '2h' } },
      api: { idle: { enabled: true, timeout: '90s' } },
      test: {},
    },
  })).toEqual(new Map([
    ['dev', { timeoutMs: 7_200_000, timeout: '2h' }],
    ['api', { timeoutMs: 90_000, timeout: '90s' }],
  ]));
});

test('the idle window grammar is the task duration grammar with a one-second floor', () => {
  expect(idleTimeoutMs('1s')).toBe(1_000);
  expect(idleTimeoutMs('1500ms')).toBe(1_500);
  expect(idleTimeoutMs('24h')).toBe(86_400_000);
  for (const value of ['999ms', '0s', '-1m', '24.5h', '30', '30 m', 'm', undefined]) {
    expect(idleTimeoutMs(value)).toBeNull();
  }
});
