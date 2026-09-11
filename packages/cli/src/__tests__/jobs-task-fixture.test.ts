import { expect, test } from 'bun:test';
import { parseWtmConfig, resolveTask } from '@wtm/core';
import { parse, stringify } from 'smol-toml';
import { createQueueTaskFixture } from './jobs-task-fixture';

test('the native queue fixture resolves through production task templates in both repositories', () => {
  const releasePath = '/tmp/external queue barrier/release';
  const fixture = createQueueTaskFixture(releasePath);
  const config = parseWtmConfig(parse(stringify(fixture.config)));
  for (const root of ['/workspace/first repo', '/workspace/second-repo']) {
    const task = resolveTask({ config, taskName: 'check', isMain: true, context: { worktree: { root } } });
    expect(task.cwd).toBe(root);
    expect(task.shell).toBe(false);
    expect(task.argv).toEqual(['node', 'queue-check.cjs', releasePath]);
    expect(fixture.files['queue-check.cjs']).toContain('START ');
    expect(fixture.files['queue-check.cjs']).toContain('END ');
  }
});
