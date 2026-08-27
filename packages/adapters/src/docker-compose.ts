import { defineBuiltInAdapter, detectMarkers } from './built-in';

export const dockerComposeAdapter = defineBuiltInAdapter({
  metadata: {
    id: 'docker-compose',
    name: 'Docker Compose',
    version: '1.0.0',
    kind: 'runtime',
    provides: ['container.compose', 'runtime.start'],
  },
  detect: ({ worktree }) => detectMarkers(worktree.root, [
    'compose.yaml',
    'compose.yml',
    'docker-compose.yaml',
    'docker-compose.yml',
  ]),
  plan: async () => ({
    resources: [],
    actions: [
      { type: 'register-runtime-namespace', namespace: 'wtm-{worktree.id}' },
    ],
    capabilities: {
      'runtime.start': { action: 'task.compose-up' },
    },
    tasks: {
      'compose-up': {
        run: ['docker', 'compose', 'up'],
        cwd: '{worktree.root}',
        background: true,
        singleton: true,
      },
    },
  }),
});
