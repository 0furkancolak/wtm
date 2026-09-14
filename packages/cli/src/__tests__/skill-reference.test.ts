import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { createCli } from '../main';

const canonicalSkillPath = resolve(import.meta.dir, '../../../../skills/wtm/SKILL.md');

// An agent that finds a command missing from the skill goes to the README, the docs or `--help`
// for it, and pays for that in every conversation. The skill is the whole reference, so a command
// registered without a row in its command map fails here instead of costing tokens later.
const skillBudgetBytes = 24 * 1024;

function visibleCommandNames(program: Command): string[] {
  const names: string[] = [];
  for (const command of program.commands) {
    if ((command as Command & { _hidden?: boolean })._hidden === true) continue;
    names.push(command.name());
    for (const subcommand of command.commands) {
      if ((subcommand as Command & { _hidden?: boolean })._hidden === true) continue;
      names.push(`${command.name()} ${subcommand.name()}`);
    }
  }
  return names;
}

function commandMap(skill: string): string {
  const start = skill.indexOf('## Command map');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = skill.indexOf('\n## ', start + 1);
  return end === -1 ? skill.slice(start) : skill.slice(start, end);
}

describe('the WTM Agent Skill as the complete reference', () => {
  test('names every visible top-level command and subcommand in its command map', async () => {
    const skill = await readFile(canonicalSkillPath, 'utf8');
    const map = commandMap(skill);

    const missing = visibleCommandNames(createCli()).filter((name) => !map.includes(`\`wtm ${name}`));

    expect(missing).toEqual([]);
  });

  test(`stays within a ${skillBudgetBytes / 1024} KiB budget, because every conversation that loads it pays for it`, async () => {
    const bytes = Buffer.byteLength(await readFile(canonicalSkillPath, 'utf8'), 'utf8');

    expect(bytes).toBeLessThanOrEqual(skillBudgetBytes);
  });
});
