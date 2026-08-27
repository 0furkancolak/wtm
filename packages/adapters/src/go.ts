import { defineBuiltInAdapter, detectMarkers } from './built-in';

export const goAdapter = defineBuiltInAdapter({
  metadata: {
    id: 'go',
    name: 'Go',
    version: '1.0.0',
    kind: 'toolchain',
    provides: ['go.toolchain', 'go.build-system', 'deps.install'],
  },
  detect: ({ worktree }) => detectMarkers(worktree.root, ['go.mod', 'go.work']),
  plan: async () => ({
    resources: [],
    actions: [{ type: 'exec', argv: ['go', 'mod', 'download'], cwd: '{worktree.root}', timeoutMs: 600_000 }],
    capabilities: {
      'deps.install': { action: 'go.mod.download' },
    },
    tasks: {},
  }),
});
