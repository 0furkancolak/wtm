import { describe, expect, it } from 'bun:test';
import { resolveTemplate, type TemplateContext } from './resolve.js';

const context: TemplateContext = {
  workspace: { root: '/workspace', name: 'dev' },
  repo: { root: '/repo', name: 'api' },
  main: { root: '/main' },
  worktree: { root: '/worktree' },
  id: 7,
  key: 'api:7',
  slug: 'api-feature',
  branch: 'feature/test',
  branchSlug: 'feature-test',
  ports: { web: 3007 },
  env: { HOME: '/home/test' },
};

describe('resolveTemplate', () => {
  it('resolves only documented variables', () => {
    expect(resolveTemplate('{workspace.name}-{repo.name}-{port.web}-{branch.slug}', context)).toBe('dev-api-3007-feature-test');
  });

  it('throws a structured unresolved-template error for an unknown port', () => {
    let thrown: unknown;
    try {
      resolveTemplate('http://localhost:{port.unknown}', context);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: 'WTM_TEMPLATE_UNRESOLVED',
      severity: 'error',
      context: { variable: 'port.unknown' },
    });
  });

  it('does not resolve inherited or empty port and environment variable names', () => {
    const unsafeContext: TemplateContext = {
      ...context,
      ports: { '': 3000 },
      env: { '': 'value' },
    };

    for (const variable of ['port.toString', 'env.constructor', 'port.', 'env.']) {
      expect(() => resolveTemplate(`{${variable}}`, unsafeContext)).toThrow();
    }
  });
});
