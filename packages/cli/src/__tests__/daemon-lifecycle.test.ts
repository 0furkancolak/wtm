import { describe, expect, test } from 'bun:test';
import { createDaemonErrorReporter, runDaemonLifecycleCommand } from '../commands/daemon';

const lifecycle = (label: string) => ({
  install: async () => ({ action: 'install', state: 'installed', label }),
  uninstall: async () => ({ action: 'uninstall', state: 'uninstalled', label }),
  status: async () => ({ action: 'status', state: 'loaded', label }),
});

describe('runDaemonLifecycleCommand', () => {
  test('install waits for the daemon to answer before saying it is installed', async () => {
    let attempts = 0;
    const envelope = await runDaemonLifecycleCommand('install', lifecycle('a') as never, async () => {
      attempts += 1;
      return attempts >= 3;
    });

    expect(envelope.ok).toBe(true);
    expect(envelope.data).toMatchObject({ state: 'installed', reachable: true });
    expect(attempts).toBe(3);
  });

  test('status says whether the socket is answering, not only what launchd thinks', async () => {
    const envelope = await runDaemonLifecycleCommand('status', lifecycle('a') as never, async () => false);

    expect(envelope.data).toMatchObject({ state: 'loaded', reachable: false });
  });

  test('uninstall has nothing to reach', async () => {
    let probed = false;
    const envelope = await runDaemonLifecycleCommand('uninstall', lifecycle('a') as never, async () => {
      probed = true;
      return true;
    });

    expect(probed).toBe(false);
    expect(envelope.data).toMatchObject({ state: 'uninstalled' });
  });

  test('without a probe the answer is what it always was', async () => {
    const envelope = await runDaemonLifecycleCommand('status', lifecycle('a') as never);

    expect(envelope.data).toEqual({ action: 'status', state: 'loaded', label: 'a' });
  });
});

describe('createDaemonErrorReporter', () => {
  const at = (iso: string) => Date.parse(iso);
  const framed = (message: string): Error => {
    const error = new Error(message);
    error.stack = [
      `Error: ${message}`,
      '    at start (/Users/runner/work/wtm/wtm/dist/sea/.build/sea-bin.cjs:41337:19)',
    ].join('\n');
    return error;
  };

  test('stamps every condition with the time it was recorded', () => {
    const lines: string[] = [];
    const report = createDaemonErrorReporter(
      (line) => lines.push(line),
      () => at('2026-08-30T16:35:52.000Z'),
      () => {},
    );

    report(new Error('first'));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('2026-08-30T16:35:52.000Z first\n');
  });

  test('reports the condition without the frames, and keeps the frames for the log', () => {
    const lines: string[] = [];
    const retained: string[] = [];
    const report = createDaemonErrorReporter(
      (line) => lines.push(line),
      () => at('2026-08-30T16:35:52.000Z'),
      (entry) => retained.push(entry),
    );

    report(framed('The runtime could not be created.'));

    expect(lines).toEqual(['2026-08-30T16:35:52.000Z The runtime could not be created.\n']);
    expect(lines[0]).not.toContain('/Users/runner');
    expect(lines[0]).not.toContain('    at ');
    // Dropping the frames from the stream must not drop them from the record.
    expect(retained).toHaveLength(1);
    expect(retained[0]).toContain('2026-08-30T16:35:52.000Z Error: The runtime could not be created.');
    expect(retained[0]).toContain('at start (/Users/runner/work/wtm/wtm/dist/sea/.build/sea-bin.cjs:41337:19)');
  });

  test('a multi-line message is a stack in all but name, so only its first line is reported', () => {
    const lines: string[] = [];
    const report = createDaemonErrorReporter(
      (line) => lines.push(line),
      () => at('2026-08-30T16:35:52.000Z'),
      () => {},
    );

    report(new Error('git failed\n    at nowhere in particular\nfatal: not a repository'));

    expect(lines).toEqual(['2026-08-30T16:35:52.000Z git failed [...]\n']);
  });

  test('a thrown value that is not an error still names something, and retains nothing', () => {
    const lines: string[] = [];
    const retained: string[] = [];
    const report = createDaemonErrorReporter(
      (line) => lines.push(line),
      () => at('2026-08-30T16:35:52.000Z'),
      (entry) => retained.push(entry),
    );

    report('a bare string');
    report(new Error(''));

    expect(lines).toEqual([
      '2026-08-30T16:35:52.000Z a bare string\n',
      '2026-08-30T16:35:52.000Z Error\n',
    ]);
    expect(retained).toHaveLength(1);
  });

  test('counts a condition that keeps recurring instead of writing it out again', () => {
    const lines: string[] = [];
    let now = at('2026-08-30T16:00:00.000Z');
    const report = createDaemonErrorReporter((line) => lines.push(line), () => now, () => {});
    // The same condition, reported from the same place on every pass: one object stands in
    // for the identically constructed error a repeated pass produces.
    const unreadable = new Error('Registered repository root is unavailable: /gone');

    report(unreadable);
    // A pass reports its other repositories in between, which is exactly why collapsing only
    // consecutive repeats never collapsed anything.
    for (let pass = 0; pass < 5; pass += 1) {
      now += 60_000;
      report(new Error(`unrelated ${pass}`));
      report(unreadable);
    }

    expect(lines.filter((line) => line.includes('/gone'))).toHaveLength(1);

    now += 10 * 60_000;
    report(unreadable);
    const repeated = lines.filter((line) => line.includes('/gone'));
    expect(repeated).toHaveLength(2);
    expect(repeated[1]).toContain('[also 5 times since 2026-08-30T16:00:00.000Z]');
  });

  test('reports a condition again once its window has passed, without a count it did not earn', () => {
    const lines: string[] = [];
    let now = at('2026-08-30T16:00:00.000Z');
    const report = createDaemonErrorReporter((line) => lines.push(line), () => now, () => {});

    report(new Error('cold volume'));
    now += 11 * 60_000;
    report(new Error('cold volume'));

    expect(lines).toHaveLength(2);
    expect(lines[1]).not.toContain('[also');
  });

  test('a suppressed repeat is not written to the log either', () => {
    const retained: string[] = [];
    const now = at('2026-08-30T16:00:00.000Z');
    const report = createDaemonErrorReporter(() => {}, () => now, (entry) => retained.push(entry));

    report(framed('the same condition'));
    report(framed('the same condition'));

    expect(retained).toHaveLength(1);
  });
});
