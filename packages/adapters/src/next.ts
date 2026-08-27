import { defineBuiltInAdapter, detectMarkers, detectPackageJsonDependency } from './built-in';

export const nextAdapter = defineBuiltInAdapter({
  metadata: {
    id: 'next',
    name: 'Next.js',
    version: '1.0.0',
    kind: 'framework',
    provides: ['javascript.framework.next'],
    requires: ['javascript.package-manager'],
  },
  async detect({ worktree }) {
    const config = await detectMarkers(worktree.root, [
      'next.config.js',
      'next.config.mjs',
      'next.config.ts',
      'next.config.cjs',
    ]);
    return config.detected ? config : detectPackageJsonDependency(worktree.root, 'next');
  },
  plan: async () => ({
    resources: [{ name: 'next-build', type: 'build-output', path: '.next', policy: 'isolated', retention: 'ephemeral' }],
    actions: [],
    capabilities: {},
    tasks: {},
  }),
});
