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

test('a failed constrained-memory read does not discard an otherwise valid physical reading', () => {
  // `constrained()` (cgroup/container limits) is the newer, less portable of the two reads, and a
  // host where it throws -- an older Node, a platform with no such concept -- is still a host
  // `total()` answered for just fine. `totalBytes` used to go null in exactly this case, because
  // both reads shared one try/catch and a throw from either discarded whatever the other had
  // already found.
  const unavailable = () => { throw new Error('constrained() not supported here'); };
  expect(readHostJobMemory({ available: () => 200, total: () => 2000, constrained: unavailable }))
    .toEqual({ availableBytes: 200, totalBytes: 2000 });
});

test('a failed physical-memory read does not fall back to an unconstrained total', () => {
  // The opposite asymmetry: `total()` throwing must not let a successful `constrained()` read
  // stand in for physical memory, since a constraint alone (with no physical figure to cap it
  // against) answers a different question than this function promises.
  const unavailable = () => { throw new Error('total() not supported here'); };
  expect(readHostJobMemory({ available: () => 200, total: unavailable, constrained: () => 800 }))
    .toEqual({ availableBytes: 200, totalBytes: null });
});
