import { defineBuiltInAdapter, detectMarkers } from './built-in';

export const bunAdapter = defineBuiltInAdapter({
  metadata: {
    id: 'bun',
    name: 'Bun',
    version: '1.0.0',
    kind: 'package-manager',
    provides: ['javascript.package-manager', 'javascript.runtime', 'deps.install'],
  },
  detect: ({ worktree }) => detectMarkers(worktree.root, ['bun.lock', 'bun.lockb']),
  plan: async () => ({
    resources: [{ name: 'bun-node-modules', type: 'dependency-view', path: 'node_modules', policy: 'isolated', retention: 'ephemeral' }],
    actions: [{ type: 'exec', argv: ['bun', 'install'], cwd: '{worktree.root}', timeoutMs: 600_000 }],
    capabilities: {
      'javascript.package-manager': { action: 'bun.install' },
      'deps.install': { action: 'bun.install' },
    },
    tasks: {},
  }),
});
