import { describe, expect, it } from 'bun:test';
import { applyTaskOverrides, mergeConfigLayers } from '../merge';

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

describe('applyTaskOverrides', () => {
  it('returns the input unchanged when there are no overrides', () => {
    const resolved = mergeConfigLayers([{ source: '/workspace/wtm.toml', value: { tasks: { dev: { run: 'npm run dev', shell: true } } } }]);
    expect(applyTaskOverrides(resolved, {})).toBe(resolved);
  });

  it('replaces a file-defined task wholesale and attributes every one of its fields to the database', () => {
    const resolved = mergeConfigLayers([{
      source: '/workspace/wtm.toml',
      value: { tasks: { dev: { run: 'npm run dev', shell: true, cwd: '/repo', background: true } } },
    }]);

    const applied = applyTaskOverrides(resolved, { dev: { run: 'npm run dev:v2', shell: true } });

    expect(applied.value.tasks?.dev).toEqual({ run: 'npm run dev:v2', shell: true });
    // The replacement left out `cwd`/`background`: no stale provenance survives for them, and
    // the ones it does carry are attributed to `db`, not to the file that no longer decides them.
    expect(applied.provenance.get('tasks.dev.run')).toEqual({ source: 'db' });
    expect(applied.provenance.get('tasks.dev.shell')).toEqual({ source: 'db' });
    expect(applied.provenance.get('tasks.dev.cwd')).toBeUndefined();
    expect(applied.provenance.get('tasks.dev.background')).toBeUndefined();
  });

  it('adds a task the files never defined, alongside the ones they did', () => {
    const resolved = mergeConfigLayers([{ source: '/workspace/wtm.toml', value: { tasks: { build: { run: 'npm run build', shell: true } } } }]);

    const applied = applyTaskOverrides(resolved, { dev: { run: 'npm run dev', shell: true } });

    expect(Object.keys(applied.value.tasks ?? {}).sort()).toEqual(['build', 'dev']);
    expect(applied.provenance.get('tasks.build.run')).toEqual({ source: '/workspace/wtm.toml' });
    expect(applied.provenance.get('tasks.dev.run')).toEqual({ source: 'db' });
  });

  it('does not mutate the resolved config it was given', () => {
    const resolved = mergeConfigLayers([{ source: '/workspace/wtm.toml', value: { tasks: { dev: { run: 'npm run dev', shell: true } } } }]);
    applyTaskOverrides(resolved, { dev: { run: 'npm run dev:v2', shell: true } });
    expect(resolved.value.tasks?.dev).toEqual({ run: 'npm run dev', shell: true });
    expect(resolved.provenance.get('tasks.dev.run')).toEqual({ source: '/workspace/wtm.toml' });
  });
});
