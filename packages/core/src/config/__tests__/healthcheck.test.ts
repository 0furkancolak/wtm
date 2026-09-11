import { describe, expect, test } from 'bun:test';
import { parseWtmConfig } from '../schema';
import { resolveTask } from '../../runtime/task-resolver';

const context = { worktree: { root: '/repo' }, ports: { web: 23456 }, env: { HEALTH_PATH: '/health' } };
const healthcheck = { type: 'http' as const, url: 'http://localhost:{port.web}{env.HEALTH_PATH}', timeout: '12s', interval: '250ms' };

describe('task healthcheck configuration', () => {
  test('accepts a bounded HTTP check and resolves its URL using the task environment', () => {
    const config = parseWtmConfig({ tasks: { dev: { run: ['node', 'server.js'], healthcheck } } });
    expect(resolveTask({ config, taskName: 'dev', isMain: true, context }).healthcheck).toEqual({
      type: 'http', url: 'http://localhost:23456/health', timeoutMs: 12000, intervalMs: 250,
    });
  });

  test('defaults observation bounds without modifying tasks that have no healthcheck', () => {
    const config = parseWtmConfig({ tasks: { dev: { run: ['node'], healthcheck: { type: 'http', url: 'https://localhost/health' } }, plain: { run: ['node'] } } });
    expect(resolveTask({ config, taskName: 'dev', isMain: true, context }).healthcheck).toEqual({
      type: 'http', url: 'https://localhost/health', timeoutMs: 30000, intervalMs: 500,
    });
    expect(resolveTask({ config, taskName: 'plain', isMain: true, context })).not.toHaveProperty('healthcheck');
  });

  test('rejects unsupported probes, invalid durations and unbounded polling at configuration load', () => {
    for (const change of [
      { type: 'command' }, { timeout: '0s' }, { timeout: '6m' }, { timeout: 'Infinity' },
      { timeout: '0.1ms' }, { interval: '0ms' }, { interval: '99ms' }, { interval: '31s' },
      { interval: 'NaN' }, { headers: { secret: 'token' } },
    ]) {
      expect(() => parseWtmConfig({ tasks: { dev: { run: ['node'], healthcheck: { ...healthcheck, ...change } } } })).toThrow();
    }
  });

  test('rejects invalid resolved URLs with a sanitized configuration error', () => {
    for (const url of ['file:///secret', 'ftp://localhost/health', 'http://user:secret@localhost/', 'http://localhost/#secret', 'not-a-url-secret']) {
      let failure: unknown;
      try {
        const config = parseWtmConfig({ tasks: { dev: { run: ['node'], healthcheck: { type: 'http', url } } } });
        resolveTask({ config, taskName: 'dev', isMain: true, context });
      } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: 'WTM_CONFIG_INVALID' });
      expect(String(failure)).not.toContain('secret');
    }
  });
});
