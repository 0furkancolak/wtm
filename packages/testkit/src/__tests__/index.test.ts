import { expect, test } from 'bun:test';
import { createFakeAdapter } from '../index';

test('exports the fake external adapter fixture from the public implementation module', async () => {
  const direct = await import('../fake-adapter');
  expect(createFakeAdapter).toBe(direct.createFakeAdapter);
});
