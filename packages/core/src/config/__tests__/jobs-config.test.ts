import { expect, test } from 'bun:test';
import { parseWtmConfig } from '../schema';

test('finite queue opt-in and global concurrency are validated', () => {
  expect(() => parseWtmConfig({ jobs: { max_concurrent_heavy: 1 }, tasks: { check: { run: ['tsc'], queue: true, timeout: '5m' } } })).not.toThrow();
  for (const timeout of [undefined, 'forever', '0s', '-1s', '90000h']) {
    expect(() => parseWtmConfig({ tasks: { check: { run: ['tsc'], queue: true, timeout } } })).toThrow();
  }
  expect(() => parseWtmConfig({ tasks: { dev: { run: ['vite'], queue: true, timeout: '1m', background: true } } })).toThrow();
  for (const max_concurrent_heavy of [0, -1, 1.5, 65]) {
    expect(() => parseWtmConfig({ jobs: { max_concurrent_heavy } })).toThrow();
  }
});
