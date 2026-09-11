import { expect, test } from 'bun:test';
import { readHostJobMemory, sanitizeHostJobMemory } from '../job-memory';

test('uses the smaller physical/OS-constrained capacity and available memory independently', () => {
  expect(readHostJobMemory({ available: () => 200, total: () => 2000, constrained: () => 800 })).toEqual({ availableBytes: 200, totalBytes: 800 });
  expect(readHostJobMemory({ available: () => 200, total: () => 2000, constrained: () => 0 })).toEqual({ availableBytes: 200, totalBytes: 2000 });
  expect(readHostJobMemory({ available: () => 0, total: () => 2000, constrained: () => 4000 })).toEqual({ availableBytes: 0, totalBytes: 2000 });
});

test('failed and malformed memory samples stay unknown without disclosing reader errors', () => {
  const unavailable = () => { throw new Error('private platform details'); };
  expect(readHostJobMemory({ available: unavailable, total: unavailable, constrained: unavailable })).toEqual({ availableBytes: null, totalBytes: null });
  for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    expect(sanitizeHostJobMemory({ availableBytes: value, totalBytes: value })).toEqual({ availableBytes: null, totalBytes: null });
  }
});
