import { defineBuiltInAdapter, detectMarkers } from './built-in';

export const pnpmAdapter = defineBuiltInAdapter({
  metadata: {
    id: 'pnpm',
    name: 'pnpm',
    version: '1.0.0',
    kind: 'package-manager',
    provides: ['javascript.package-manager', 'deps.install'],
  },
  detect: ({ worktree }) => detectMarkers(worktree.root, ['pnpm-lock.yaml']),
  plan: async () => ({
    resources: [{ name: 'pnpm-node-modules', type: 'dependency-view', path: 'node_modules', policy: 'isolated', retention: 'ephemeral' }],
    actions: [{ type: 'exec', argv: ['pnpm', 'install', '--frozen-lockfile'], cwd: '{worktree.root}', timeoutMs: 600_000 }],
    capabilities: {
      'javascript.package-manager': { action: 'pnpm.install' },
      'deps.install': { action: 'pnpm.install' },
    },
    tasks: {},
  }),
});
