import type { AdapterPlan, DetectionResult } from '@wtm/protocol';
import { defineBuiltInAdapter, detectFilePattern, detectMarkers } from './built-in';

const requirementMarkers = ['requirements.txt', 'requirements-dev.txt'] as const;
const venvMarkers = ['.venv/pyvenv.cfg'] as const;

export const uvAdapter = defineBuiltInAdapter({
  metadata: {
    id: 'uv',
    name: 'uv / Python virtualenv',
    version: '1.0.0',
    kind: 'package-manager',
    provides: ['python.environment-manager', 'python.package-manager', 'deps.install'],
  },
  async detect({ worktree }) {
    const nativeUv = await detectNativeUv(worktree.root);
    if (nativeUv.detected) return nativeUv;
    return detectMarkers(worktree.root, [...requirementMarkers, ...venvMarkers], 0.6);
  },
  async plan({ worktree }) {
    const nativeUv = await detectNativeUv(worktree.root);
    const actions: AdapterPlan['actions'] = [];
    const capabilities: AdapterPlan['capabilities'] = {};

    if (nativeUv.detected) {
      actions.push({ type: 'exec', argv: ['uv', 'sync'], cwd: '{worktree.root}', timeoutMs: 600_000 });
      capabilities['python.environment-manager'] = { action: 'uv.sync' };
      capabilities['deps.install'] = { action: 'uv.sync' };
    } else {
      const requirements = await detectMarkers(worktree.root, requirementMarkers, 0.6);
      const existingVenv = await detectMarkers(worktree.root, venvMarkers, 0.6);
      const requirementsFile = requirements.evidence[0]?.value;
      if (requirementsFile !== undefined) {
        if (!existingVenv.detected) {
          actions.push({ type: 'exec', argv: ['python3', '-m', 'venv', '.venv'], cwd: '{worktree.root}', timeoutMs: 600_000 });
          capabilities['python.environment-manager'] = { action: 'python.venv' };
        }
        actions.push({
          type: 'exec',
          argv: ['.venv/bin/python', '-m', 'pip', 'install', '-r', requirementsFile],
          cwd: '{worktree.root}',
          timeoutMs: 600_000,
        });
        capabilities['deps.install'] = { action: 'python.pip.install' };
      }
    }

    return {
      resources: [{ name: 'python-venv', type: 'environment', path: '.venv', policy: 'isolated', retention: 'ephemeral' }],
      actions,
      capabilities,
      tasks: {},
    };
  },
});

async function detectNativeUv(root: string): Promise<DetectionResult> {
  const lockfile = await detectMarkers(root, ['uv.lock']);
  if (lockfile.detected) return lockfile;
  return detectFilePattern(root, 'pyproject.toml', /^\s*\[tool\.uv(?:\.[^\]]+)?\]\s*$/m, 0.9);
}
