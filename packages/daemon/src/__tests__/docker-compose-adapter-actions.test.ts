import { describe, expect, it } from 'bun:test';
import { resolveTemplate, WtmTemplateError, type TemplateContext } from '@wtm/core';
import { builtInAdapters } from '@wtm/adapters';
import type { AdapterContext } from '@wtm/protocol';

const dockerComposeAdapter = builtInAdapters.find((adapter) => adapter.metadata().id === 'docker-compose');
if (dockerComposeAdapter === undefined) throw new Error('docker-compose adapter is no longer registered');

const context: AdapterContext = {
  workspace: { root: '/workspace' },
  repository: { root: '/workspace/repo', mainRoot: '/workspace/repo' },
  worktree: { root: '/workspace/repo', id: 7, branch: 'main' },
};

describe('docker-compose adapter actions', () => {
  it('emits a register-runtime-namespace action whose template actually resolves', async () => {
    const plan = await dockerComposeAdapter.plan(context);
    const action = plan.actions.find((candidate) => candidate.type === 'register-runtime-namespace');
    expect(action).toBeDefined();
    const namespace = (action as { namespace: string }).namespace;

    // `{worktree.id}` is not a variable `templateValue` (packages/core/src/templates/resolve.ts)
    // recognizes -- the worktree's numeric id is only ever exposed as the bare `{id}` -- so the
    // action used to throw `WtmTemplateError` the moment anything actually resolved it.
    const templateContext: TemplateContext = { id: 7 };
    expect(resolveTemplate(namespace, templateContext)).toBe('wtm-7');
  });

  it('documents why {worktree.id} is not the right spelling: it is not a resolvable template variable', () => {
    expect(() => resolveTemplate('wtm-{worktree.id}', { id: 7 })).toThrow(WtmTemplateError);
  });
});
