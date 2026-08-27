import { describe, expect, it } from 'bun:test';
import { createAdapterFixture } from './fixture';
import { uvAdapter } from '../uv';

describe('uv adapter planning', () => {
  it('uses uv sync for a pyproject with native uv configuration', async () => {
    const fixture = await createAdapterFixture({
      'pyproject.toml': '[project]\nname = "fixture"\n[tool.uv]\nmanaged = true\n',
    });
    try {
      const plan = await uvAdapter.plan(fixture.context);

      expect(plan.actions).toEqual([
        { type: 'exec', argv: ['uv', 'sync'], cwd: '{worktree.root}', timeoutMs: 600_000 },
      ]);
      expect(plan.capabilities).toEqual({
        'python.environment-manager': { action: 'uv.sync' },
        'deps.install': { action: 'uv.sync' },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('installs the first supported requirements fallback deterministically', async () => {
    const fixture = await createAdapterFixture({
      'requirements-dev.txt': 'pytest==8.4.2\n',
    });
    try {
      const plan = await uvAdapter.plan(fixture.context);

      expect(plan.actions).toEqual([
        { type: 'exec', argv: ['python3', '-m', 'venv', '.venv'], cwd: '{worktree.root}', timeoutMs: 600_000 },
        {
          type: 'exec',
          argv: ['.venv/bin/python', '-m', 'pip', 'install', '-r', 'requirements-dev.txt'],
          cwd: '{worktree.root}',
          timeoutMs: 600_000,
        },
      ]);
      expect(plan.capabilities['deps.install']).toEqual({ action: 'python.pip.install' });
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not advertise or schedule dependency installation for an existing venv alone', async () => {
    const fixture = await createAdapterFixture({
      '.venv/pyvenv.cfg': 'home = /usr/bin\n',
    });
    try {
      const plan = await uvAdapter.plan(fixture.context);

      expect(plan.actions).toEqual([]);
      expect(plan.capabilities).toEqual({});
    } finally {
      await fixture.cleanup();
    }
  });
});
