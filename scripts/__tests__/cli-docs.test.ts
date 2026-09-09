import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command } from 'commander';
import { createCli } from '../../packages/cli/src/main';

const root = new URL('../../', import.meta.url);
const documents = ['README.md', 'docs/04-cli-reference.md', 'skills/wtm/SKILL.md', ...await markdownFiles('examples')];

describe('documented CLI commands', () => {
  for (const document of documents.sort()) {
    test(`${document} references registered command and option names`, async () => {
      const references = commandReferences(await readFile(new URL(document, root), 'utf8'));
      const failures = references.flatMap(({ command, line }) =>
        validateReference(command).map((error) => `${document}:${line}: ${error}`));
      expect(failures).toEqual([]);
    });
  }

  test('detects drift in root commands, subcommands, and options without running actions', () => {
    expect(validateReference('wtm missing')).toEqual(['unknown command: wtm missing']);
    expect(validateReference('wtm daemon missing')).toEqual(['unknown command: wtm daemon missing']);
    expect(validateReference('wtm remove <selector> --force')).toEqual(['unknown option: wtm remove --force']);
    expect(validateReference('wtm skill --install')).toEqual(['unknown option: wtm skill --install']);
    expect(validateReference('wtm skill install --global')).toEqual([]);
    expect(validateReference('wtm create feat/auth --from main --json')).toEqual([]);
    expect(validateReference('wtm exec -- node --unknown-child-option')).toEqual([]);
    expect(validateReference('wtm start/stop/restart <task>')).toEqual([]);
    expect(validateReference('wtm run typecheck --enqueue --idempotency-key check-1 --json')).toEqual([]);
    expect(validateReference('wtm jobs list --limit 50 --json')).toEqual([]);
    expect(validateReference('wtm jobs logs <job-id> --tail 100 --json')).toEqual([]);
    expect(validateReference('wtm jobs result <job-id> --json')).toEqual([]);
    expect(validateReference('wtm jobs missing')).toEqual(['unknown command: wtm jobs missing']);
    expect(validateReference('wtm jobs logs <job-id> --follow')).toEqual(['unknown option: wtm jobs logs --follow']);
  });

  test('reads fenced examples and inline references, preserving source locations', () => {
    expect(commandReferences([
      'Text about wtm imaginary is not an invocation.',
      '`wtm status` and `wtm ports --json`.',
      '```bash',
      '$ wtm remove feature # wtm invalid in a comment',
      '```',
      '```json',
      '"wtm invalid"',
      '```',
    ].join('\n'))).toEqual([
      { command: 'wtm status', line: 2 },
      { command: 'wtm ports --json', line: 2 },
      { command: 'wtm remove feature', line: 4 },
    ]);
  });
});

async function markdownFiles(directory: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(new URL(`${directory}/`, root), { withFileTypes: true })) {
    const path = join(directory, entry.name).replaceAll('\\', '/');
    if (entry.isDirectory()) paths.push(...await markdownFiles(path));
    else if (entry.name.endsWith('.md')) paths.push(path);
  }
  return paths;
}

function commandReferences(markdown: string): { command: string; line: number }[] {
  const references: { command: string; line: number }[] = [];
  let fence: string | null = null;
  for (const [index, line] of markdown.split('\n').entries()) {
    const boundary = /^\s*```(\S*)/.exec(line);
    if (boundary !== null) { fence = fence === null ? boundary[1] ?? '' : null; continue; }
    const snippets = fence === null
      ? [...line.matchAll(/`(wtm(?:\s+[^`]+)?)`/g)].map((match) => match[1]!)
      : ['', 'bash', 'sh', 'shell', 'zsh', 'fish', 'powershell', 'text'].includes(fence)
        ? [line.replace(/^\s*(?:\$\s+)?/, '')].filter((value) => /^wtm(?:\s|$)/.test(value)) : [];
    for (const snippet of snippets) {
      references.push({ command: snippet.replace(/\s+#.*$/, '').trim(), line: index + 1 });
    }
  }
  return references;
}

/** Inspect Commander metadata only: example commands must never create, start, or remove anything. */
function validateReference(reference: string): string[] {
  const words = reference.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const [name, ...rest] = words.slice(1);
  if (name === undefined) return [];
  const failures: string[] = [];
  for (const variant of name.split('/')) {
    let command: Command = createCli();
    let path = 'wtm';
    const tokens = [variant, ...rest];
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (token === '--') break;
      if (token.startsWith('-')) {
        const flag = token.split('=')[0]!;
        const option = command.options.find((entry) => entry.long === flag || entry.short === flag);
        if (flag === '--help' || flag === '-h') continue;
        if (option === undefined) { failures.push(`unknown option: ${path} ${flag}`); continue; }
        if (option.required && !token.includes('=')) index += 1;
        continue;
      }
      if (/^[<[]/.test(token)) continue; // A reference may intentionally omit concrete arguments.
      if (command.commands.length === 0) {
        if (command.registeredArguments.some((argument) => argument.variadic)) break;
        continue;
      }
      const child = command.commands.find((entry) => entry.name() === token || entry.aliases().includes(token));
      if (child === undefined) { failures.push(`unknown command: ${path} ${token}`); break; }
      command = child;
      path += ` ${token}`;
    }
  }
  return failures;
}
