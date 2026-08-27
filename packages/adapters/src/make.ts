import { defineBuiltInAdapter, detectMarkers } from './built-in';

export const makeAdapter = defineBuiltInAdapter({
  metadata: {
    id: 'make',
    name: 'Make',
    version: '1.0.0',
    kind: 'task-runner',
    provides: ['make.task-runner'],
  },
  detect: ({ worktree }) => detectMarkers(worktree.root, ['Makefile', 'makefile', 'GNUmakefile']),
  plan: async () => ({
    resources: [],
    actions: [],
    capabilities: {},
    tasks: {
      make: { run: ['make'], cwd: '{worktree.root}' },
    },
  }),
});
