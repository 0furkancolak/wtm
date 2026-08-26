import { describe, expect, it } from 'bun:test';
import { mergeConfigLayers } from './merge.js';

describe('mergeConfigLayers', () => {
  it('applies defaults and adapter suggestions below explicit configuration in precedence order', () => {
    const resolved = mergeConfigLayers([
      {
        source: 'built-in',
        value: { ports: { web: { preferred: 1000 } }, tasks: { dev: { run: ['builtin'] } } },
      },
      {
        source: 'adapter',
        value: { ports: { web: { preferred: 2000 } }, tasks: { dev: { run: ['adapter'] } } },
      },
      {
        source: '/config/global.toml',
        value: { ports: { web: { preferred: 3000 } }, tasks: { dev: { run: ['global'] } } },
      },
      {
        source: '/workspace/wtm.toml',
        value: { ports: { web: { preferred: 4000 } }, tasks: { dev: { run: ['workspace'] } } },
      },
      {
        source: '/workspace/apps/api/wtm.toml',
        value: { ports: { web: { preferred: 5000 } } },
      },
      {
        source: '/workspace/apps/api/.wtm.toml',
        value: { ports: { web: { preferred: 6000 } }, tasks: { dev: { run: ['repo'] } } },
      },
    ]);

    expect(resolved.value.ports?.web?.preferred).toBe(6000);
    expect(resolved.value.tasks?.dev?.run).toEqual(['repo']);
    expect(resolved.provenance.get('ports.web.preferred')).toEqual({
      source: '/workspace/apps/api/.wtm.toml',
    });
    expect(resolved.provenance.get('tasks.dev.run')).toEqual({
      source: '/workspace/apps/api/.wtm.toml',
    });
  });

  it('rejects dangerous object keys without mutating Object.prototype or the resolved config', () => {
    const dangerousLayers = ['__proto__', 'constructor', 'prototype'].map((key) => ({
      source: `/${key}.toml`,
      value: JSON.parse(`{"${key}":{"polluted":true}}`) as object,
    }));

    for (const layer of dangerousLayers) {
      expect(() => mergeConfigLayers([layer])).toThrow();
    }
    expect(Object.prototype).not.toHaveProperty('polluted');
  });
});
