import { describe, expect, test } from 'bun:test';
import {
  renderCompletionScript,
  SUPPORTED_COMPLETION_KINDS,
  SUPPORTED_SHELLS,
  validateCompletionKind,
} from '../completion';
import { createCli, runCli } from '../../main';

const sampleCommands = ['status', 'resolve', 'run', 'analyze', 'remove', 'forget', 'completion'];

function capture() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: (value: string) => { stdout += value; },
      stderr: (value: string) => { stderr += value; },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe('renderCompletionScript', () => {
  test('renders non-empty, shell-plausible bash output naming every command', () => {
    const result = renderCompletionScript({ shell: 'bash', binaryName: 'wtm', commands: sampleCommands });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.script.length).toBeGreaterThan(0);
    expect(result.script).toContain('complete -F _wtm_completion wtm');
    for (const command of sampleCommands) expect(result.script).toMatch(new RegExp(`\\b${command}\\b`));
  });

  test('renders non-empty, shell-plausible zsh output naming every command', () => {
    const result = renderCompletionScript({ shell: 'zsh', binaryName: 'wtm', commands: sampleCommands });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.script.length).toBeGreaterThan(0);
    expect(result.script.startsWith('#compdef wtm')).toBe(true);
    expect(result.script).toContain('compdef _wtm wtm');
    for (const command of sampleCommands) expect(result.script).toMatch(new RegExp(`\\b${command}\\b`));
  });

  test('renders non-empty, shell-plausible fish output naming every command', () => {
    const result = renderCompletionScript({ shell: 'fish', binaryName: 'wtm', commands: sampleCommands });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.script.length).toBeGreaterThan(0);
    expect(result.script).toContain('complete -c wtm -f');
    for (const command of sampleCommands) expect(result.script).toMatch(new RegExp(`\\b${command}\\b`));
  });

  test('wires task, worktree, and repo argument commands to their own `__complete` kind', () => {
    const bash = renderCompletionScript({ shell: 'bash', binaryName: 'wtm', commands: sampleCommands });
    const zsh = renderCompletionScript({ shell: 'zsh', binaryName: 'wtm', commands: sampleCommands });
    const fish = renderCompletionScript({ shell: 'fish', binaryName: 'wtm', commands: sampleCommands });
    expect(bash.ok && zsh.ok && fish.ok).toBe(true);
    if (!bash.ok || !zsh.ok || !fish.ok) return;

    expect(bash.script).toContain('wtm __complete tasks');
    expect(bash.script).toContain('wtm __complete worktrees');
    expect(bash.script).toContain('wtm __complete repos');
    expect(zsh.script).toContain('wtm __complete tasks');
    expect(zsh.script).toContain('wtm __complete worktrees');
    expect(zsh.script).toContain('wtm __complete repos');
    expect(fish.script).toContain('wtm __complete tasks');
    expect(fish.script).toContain('wtm __complete worktrees');
    expect(fish.script).toContain('wtm __complete repos');
  });

  test('omits a dynamic kind entirely when none of its commands are registered', () => {
    const result = renderCompletionScript({ shell: 'bash', binaryName: 'wtm', commands: ['status', 'doctor'] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.script).not.toContain('__complete tasks');
    expect(result.script).not.toContain('__complete worktrees');
    expect(result.script).not.toContain('__complete repos');
  });

  test('rejects an unsupported shell with the WTM_CONFIG_INVALID coded error', () => {
    const result = renderCompletionScript({ shell: 'powershell', binaryName: 'wtm', commands: sampleCommands });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'WTM_CONFIG_INVALID',
        message: expect.stringContaining('powershell') as unknown as string,
        severity: 'error',
        context: { shell: 'powershell' },
      },
    });
  });

  test('supports exactly bash, zsh, and fish', () => {
    expect(SUPPORTED_SHELLS).toEqual(['bash', 'zsh', 'fish']);
  });
});

describe('validateCompletionKind', () => {
  test('accepts every supported completion data kind', () => {
    for (const kind of SUPPORTED_COMPLETION_KINDS) {
      expect(validateCompletionKind(kind)).toEqual({ ok: true, kind });
    }
  });

  test('rejects an unsupported kind with the WTM_CONFIG_INVALID coded error', () => {
    expect(validateCompletionKind('branches')).toEqual({
      ok: false,
      error: {
        code: 'WTM_CONFIG_INVALID',
        message: expect.stringContaining('branches') as unknown as string,
        severity: 'error',
        context: { kind: 'branches' },
      },
    });
  });
});

describe('wtm completion (CLI)', () => {
  test('exposes a completion command that never drifts from the CLI\'s own registered commands', () => {
    // The regression this guards: `wtm completion` reading a hand-copied command list instead
    // of `program.commands` itself. A newly registered top-level command reaches this array
    // exactly the same way `main.test.ts` proves the command roster itself, so a command added
    // to `createCli` without any completion change still shows up here automatically.
    const liveCommands = createCli().commands
      .map((command) => command.name())
      .filter((name) => name !== '__complete');
    const result = renderCompletionScript({ shell: 'bash', binaryName: 'wtm', commands: liveCommands });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const command of liveCommands) expect(result.script).toMatch(new RegExp(`\\b${command}\\b`));
    expect(liveCommands).not.toContain('__complete');
  });

  for (const shell of SUPPORTED_SHELLS) {
    test(`prints a non-empty ${shell} script to stdout and exits 0`, async () => {
      const output = capture();

      const exitCode = await runCli(['completion', shell], output.io);

      expect(exitCode).toBe(0);
      expect(output.stderr()).toBe('');
      expect(output.stdout().length).toBeGreaterThan(0);
    });
  }

  test('never lists its own internal `__complete` command as something to run', async () => {
    const output = capture();

    await runCli(['completion', 'bash'], output.io);

    const topLevelWords = /compgen -W "([^"]*)" -- "\$cur"\) \)\n {4}return 0/.exec(output.stdout())?.[1];
    expect(topLevelWords).toBeDefined();
    expect(topLevelWords?.split(' ')).not.toContain('__complete');
  });

  test('rejects an unsupported shell with exit code 2 and a coded stderr line', async () => {
    const output = capture();

    const exitCode = await runCli(['completion', 'powershell'], output.io);

    expect(exitCode).toBe(2);
    expect(output.stdout()).toBe('');
    expect(output.stderr()).toContain('[WTM_CONFIG_INVALID]');
  });

  test('keeps `__complete` out of `--help`, and lists `completion`', async () => {
    const output = capture();

    await runCli(['--help'], output.io);

    expect(output.stdout()).toContain('completion');
    expect(output.stdout()).not.toContain('__complete');
  });
});

describe('wtm __complete (CLI)', () => {
  test('prints injected candidates one per line', async () => {
    const output = capture();

    const exitCode = await runCli(['__complete', 'tasks'], {
      ...output.io,
      completionDataRunner: async ({ kind }) => {
        expect(kind).toBe('tasks');
        return ['build', 'test'];
      },
    });

    expect(exitCode).toBe(0);
    expect(output.stderr()).toBe('');
    expect(output.stdout()).toBe('build\ntest\n');
  });

  test('prints nothing for an empty candidate list', async () => {
    const output = capture();

    const exitCode = await runCli(['__complete', 'worktrees'], {
      ...output.io,
      completionDataRunner: async () => [],
    });

    expect(exitCode).toBe(0);
    expect(output.stdout()).toBe('');
  });

  test('passes the invoking cwd through to the injected runner', async () => {
    const output = capture();
    let seenCwd: string | undefined;

    await runCli(['__complete', 'repos'], {
      ...output.io,
      cwd: '/some/workspace',
      completionDataRunner: async ({ cwd }) => {
        seenCwd = cwd;
        return [];
      },
    });

    expect(seenCwd).toBe('/some/workspace');
  });

  test('rejects an unsupported kind with exit code 2 and a coded stderr line, without invoking the runner', async () => {
    const output = capture();
    let called = false;

    const exitCode = await runCli(['__complete', 'branches'], {
      ...output.io,
      completionDataRunner: async () => { called = true; return []; },
    });

    expect(exitCode).toBe(2);
    expect(output.stdout()).toBe('');
    expect(output.stderr()).toContain('[WTM_CONFIG_INVALID]');
    expect(called).toBe(false);
  });
});
