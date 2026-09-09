import { expect, test } from 'bun:test';
import { readHeavyJobScope } from '../job-scope';

const machine = '123456781234123412341234567890ab';
test('queue scope is stable for one machine/user and differs across hosts or users', async () => {
  const readers = { read: async () => machine, uid: () => 1000 };
  const first = await readHeavyJobScope('linux', readers);
  expect(await readHeavyJobScope('linux', readers)).toBe(first);
  expect(await readHeavyJobScope('linux', { ...readers, read: async () => 'a'.repeat(32) })).not.toBe(first);
  expect(await readHeavyJobScope('linux', { ...readers, uid: () => 1001 })).not.toBe(first);
  expect(first).toMatch(/^wtm-jobs-v1:[a-f0-9]{64}$/);
  expect(first).not.toContain(machine);
});

test('macOS and Windows use bounded OS machine identifiers with explicit user identity', async () => {
  const uuid = '12345678-1234-1234-1234-1234567890ab';
  const darwin = await readHeavyJobScope('darwin', { run: async () => `"IOPlatformUUID" = "${uuid}"`, uid: () => 501 });
  const win = await readHeavyJobScope('win32', { run: async () => JSON.stringify({ machine: uuid, user: 'S-1-5-21-1-2-3-1001' }) });
  expect(darwin).toMatch(/^wtm-jobs-v1:/);
  expect(win).not.toBe(darwin);
});

test('missing, malformed and placeholder host identities fail closed without hostname fallback', async () => {
  for (const text of ['', 'uninitialized', '0'.repeat(32), 'f'.repeat(32), 'not-an-id']) {
    await expect(readHeavyJobScope('linux', { read: async () => text, uid: () => 1000 })).rejects.toMatchObject({ code: 'WTM_JOB_NOT_QUEUEABLE' });
  }
  await expect(readHeavyJobScope('linux', { read: async () => machine, uid: () => undefined })).rejects.toThrow();
  await expect(readHeavyJobScope('win32', { run: async () => JSON.stringify({ machine, user: 'unknown' }) })).rejects.toThrow();
});
