import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { filesystemSkillAssets } from '../assets';
import { readCanonicalSkill } from '../commands/skill';

const canonicalSkillPath = resolve(import.meta.dir, '../../../../skills/wtm/SKILL.md');

describe('filesystem skill assets', () => {
  test('reads the canonical shipped SKILL.md bytes exactly', async () => {
    const expected = await readFile(canonicalSkillPath, 'utf8');

    await expect(filesystemSkillAssets.readCanonicalSkill()).resolves.toBe(expected);
  });

  test('readCanonicalSkill uses its injected provider', async () => {
    const sentinel = 'injected canonical skill';

    await expect(readCanonicalSkill({ readCanonicalSkill: async () => sentinel })).resolves.toBe(sentinel);
  });
});
