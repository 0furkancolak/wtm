import { expect, it } from 'bun:test';

it('exports the built-in adapter registry', async () => {
  const registry = await import('../registry').catch(() => null);

  expect(registry).not.toBeNull();
  expect(registry).toHaveProperty('builtInAdapters');
  expect(registry).toHaveProperty('detectBuiltInAdapters');
});
