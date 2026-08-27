import { defineBuiltInAdapter, detectMarkers } from './built-in';

export const cargoAdapter = defineBuiltInAdapter({
  metadata: {
    id: 'cargo',
    name: 'Cargo',
    version: '1.0.0',
    kind: 'package-manager',
    provides: ['rust.package-manager', 'rust.build-system', 'deps.install'],
  },
  detect: ({ worktree }) => detectMarkers(worktree.root, ['Cargo.toml']),
  plan: async () => ({
    resources: [{ name: 'cargo-target', type: 'build-output', path: 'target', policy: 'isolated', retention: 'ephemeral' }],
    actions: [{ type: 'exec', argv: ['cargo', 'fetch'], cwd: '{worktree.root}', timeoutMs: 600_000 }],
    capabilities: {
      'rust.package-manager': { action: 'cargo.fetch' },
      'deps.install': { action: 'cargo.fetch' },
    },
    tasks: {},
  }),
});
