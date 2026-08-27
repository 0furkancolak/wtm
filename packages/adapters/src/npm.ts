import { defineBuiltInAdapter, detectMarkers } from './built-in';

export const npmAdapter = defineBuiltInAdapter({
  metadata: {
    id: 'npm',
    name: 'npm',
    version: '1.0.0',
    kind: 'package-manager',
    provides: ['javascript.package-manager', 'deps.install'],
  },
  detect: ({ worktree }) => detectMarkers(worktree.root, ['package-lock.json', 'npm-shrinkwrap.json']),
  plan: async () => ({
    resources: [{ name: 'npm-node-modules', type: 'dependency-view', path: 'node_modules', policy: 'isolated', retention: 'ephemeral' }],
    actions: [{ type: 'exec', argv: ['npm', 'ci'], cwd: '{worktree.root}', timeoutMs: 600_000 }],
    capabilities: {
      'javascript.package-manager': { action: 'npm.install' },
      'deps.install': { action: 'npm.install' },
    },
    tasks: {},
  }),
});
