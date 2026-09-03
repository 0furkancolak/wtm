/**
 * Proves the Windows Scheduled Task descriptor's argument vectors and state machine against
 * fixture `ServiceCommandResult`s — nothing here runs `schtasks.exe`. See `../windows.ts`'s doc
 * comment for what this does and does not prove, mirroring `linux-service.test.ts`'s own split
 * between "the shape of the commands" and "whether the manager accepts them."
 */
import { describe, expect, test } from 'bun:test';
import { windowsPlatformPaths } from '../../paths';
import {
  renderScheduledTaskXml,
  runSchtasks,
  scheduledTaskCommands,
  scheduledTaskLabelFor,
  windowsServiceBackend,
} from '../windows';
import type { ServiceCommandResult } from '../types';

const home = 'C:\\Users\\test';
const label = scheduledTaskLabelFor(home);

function query(status: string): ServiceCommandResult {
  return {
    outcome: 'success',
    exitCode: 0,
    stdout: `TaskName:                             \\WTM\\${label}\nStatus:                               ${status}\n`,
    stderr: '',
  };
}

describe('scheduled task naming', () => {
  test('derives the task from HOME with the same hash construction launchd and systemd use', () => {
    // Not the same *value* as `homeDigest`: that function resolves `home` with the default
    // (POSIX) `node:path`, which cannot be reused for a Windows-shaped path tested on this
    // macOS host (see `windowsHomeDigest`'s own comment). The construction — sha256, hex, 32
    // characters — is still the one rule stated once.
    expect(label).toMatch(/^wtm-daemon-[0-9a-f]{32}$/);
    expect(scheduledTaskLabelFor(`${home}\\`)).toBe(label);
    expect(scheduledTaskLabelFor('C:\\Users\\other')).not.toBe(label);
    expect(() => scheduledTaskLabelFor('relative\\home')).toThrow('must be absolute');
  });

  test('stages the definition under the WTM-owned service root', () => {
    const paths = windowsPlatformPaths({ home, env: {} });
    expect(paths.serviceRoot).toBe('C:\\Users\\test\\AppData\\Local\\WTM\\service');
    expect(windowsServiceBackend.definitionPath({ serviceRoot: paths.serviceRoot, label }))
      .toBe(`C:\\Users\\test\\AppData\\Local\\WTM\\service\\${label}.xml`);
  });
});

describe('scheduled task commands', () => {
  test('names the task after the staged file it is given, not a fixed name', () => {
    const commands = scheduledTaskCommands({ uid: 0, definitionPath: `C:\\units\\${label}.xml` });
    expect(commands.enable).toEqual(['schtasks.exe', '/Create', '/TN', `\\WTM\\${label}`, '/XML', `C:\\units\\${label}.xml`, '/F']);
    expect(() => scheduledTaskCommands({ uid: 0, definitionPath: 'C:\\units\\agent.txt' }))
      .toThrow('must name a scheduled task');
  });

  test('drives the current-user task and Task Scheduler itself, and nothing else', () => {
    const task = `\\WTM\\${label}`;
    expect(scheduledTaskCommands({ uid: 0, definitionPath: `C:\\units\\${label}.xml` })).toEqual({
      print: ['schtasks.exe', '/Query', '/TN', task, '/FO', 'LIST', '/V'],
      printDomain: ['sc.exe', 'query', 'Schedule'],
      enable: ['schtasks.exe', '/Create', '/TN', task, '/XML', `C:\\units\\${label}.xml`, '/F'],
      disable: ['schtasks.exe', '/Change', '/TN', task, '/DISABLE'],
      bootstrap: ['schtasks.exe', '/Run', '/TN', task],
      bootout: ['schtasks.exe', '/End', '/TN', task],
      kickstart: ['schtasks.exe', '/Run', '/TN', task],
    });
    // No `reload`: Task Scheduler has nothing cached the way systemd does — `/Create` both writes
    // and activates a registration in the same step.
    expect(scheduledTaskCommands({ uid: 0, definitionPath: `C:\\units\\${label}.xml` }).reload).toBeUndefined();
  });

  test('refuses to run an argv that is not schtasks or sc', async () => {
    await expect(runSchtasks(['cmd.exe', '/c', 'echo hi'])).rejects.toMatchObject({
      code: 'INVALID_LAUNCHD_CONFIGURATION',
    });
  });
});

describe('scheduled task XML body', () => {
  test('renders a logon-triggered, least-privilege task with the given command and arguments', () => {
    const xml = renderScheduledTaskXml({
      label,
      programArguments: ['C:\\Program Files\\WTM\\wtm.exe', 'daemon', '--foreground'],
      home,
      workingDirectory: home,
      stdoutPath: 'C:\\Users\\test\\AppData\\Local\\WTM\\logs\\out.log',
      stderrPath: 'C:\\Users\\test\\AppData\\Local\\WTM\\logs\\err.log',
    });
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(xml).toContain('<Command>C:\\Program Files\\WTM\\wtm.exe</Command>');
    expect(xml).toContain('<Arguments>daemon --foreground</Arguments>');
    expect(xml).toContain(`<WorkingDirectory>${home}</WorkingDirectory>`);
  });

  test('quotes an argument containing a space and escapes XML-significant characters', () => {
    const xml = renderScheduledTaskXml({
      label,
      programArguments: ['C:\\wtm.exe', '--home', 'C:\\Users\\a & b'],
      home,
      workingDirectory: home,
      stdoutPath: 'C:\\out.log',
      stderrPath: 'C:\\err.log',
    });
    expect(xml).toContain('&amp;');
    // No bare `&` outside a recognised XML entity — the surrounding quotes an argument with a
    // space picks up also become `&quot;`, which a naive "every `&` starts `&amp;`" check would
    // wrongly flag.
    expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  test('rejects an empty argv, a relative executable, and an embedded newline', () => {
    expect(() => renderScheduledTaskXml({
      label, programArguments: [], home, workingDirectory: home, stdoutPath: 'C:\\o', stderrPath: 'C:\\e',
    })).toThrow('argv must not be empty');
    expect(() => renderScheduledTaskXml({
      label, programArguments: ['wtm.exe'], home, workingDirectory: home, stdoutPath: 'C:\\o', stderrPath: 'C:\\e',
    })).toThrow('must be absolute');
    expect(() => renderScheduledTaskXml({
      label, programArguments: ['C:\\wtm.exe', 'a\nb'], home, workingDirectory: home, stdoutPath: 'C:\\o', stderrPath: 'C:\\e',
    })).toThrow();
  });
});

describe('scheduled task status interpretation', () => {
  test('a running task is loaded', () => {
    expect(windowsServiceBackend.interpretStatus(query('Running'))).toBe('loaded');
  });

  test('a merely-registered task (Ready, Disabled, Queued) is reported absent, the way an inactive systemd unit is', () => {
    for (const status of ['Ready', 'Disabled', 'Queued']) {
      expect(windowsServiceBackend.interpretStatus(query(status))).toBe('absent');
    }
  });

  test('reports the manager\'s own word for what the job is doing', () => {
    expect(windowsServiceBackend.runState(query('Running'))).toBe('Running');
    expect(windowsServiceBackend.runState({ outcome: 'not-found', exitCode: 1, stdout: '', stderr: '' })).toBeNull();
  });
});

describe('scheduled task managed directories', () => {
  test('walks one WTM-owned chain from home, unlike systemd\'s split ownership', () => {
    const paths = windowsPlatformPaths({ home, env: {} });
    const plan = windowsServiceBackend.directories({
      home, serviceRoot: paths.serviceRoot, dataRoot: paths.dataRoot, logRoot: paths.logRoot,
    });
    expect(plan.root).toBe(home);
    expect(plan.definition).toEqual([
      { path: 'C:\\Users\\test\\AppData', ownerOnly: false },
      { path: 'C:\\Users\\test\\AppData\\Local', ownerOnly: false },
      { path: 'C:\\Users\\test\\AppData\\Local\\WTM', ownerOnly: false },
      { path: 'C:\\Users\\test\\AppData\\Local\\WTM\\service', ownerOnly: true },
    ]);
    // `AppData\Local\WTM` appears in both the definition chain (as a shared intermediate,
    // `ownerOnly: false`) and the data-root chain (as its own leaf, `ownerOnly: true`) — unlike
    // systemd's disjoint `~/.config`/`~/.local` roots, `serviceRoot` nests inside `dataRoot` here.
    // The merge takes the stricter of the two rather than whichever occurrence came first.
    expect(plan.install).toEqual([
      { path: 'C:\\Users\\test\\AppData', ownerOnly: false },
      { path: 'C:\\Users\\test\\AppData\\Local', ownerOnly: false },
      { path: 'C:\\Users\\test\\AppData\\Local\\WTM', ownerOnly: true },
      { path: 'C:\\Users\\test\\AppData\\Local\\WTM\\service', ownerOnly: true },
      { path: 'C:\\Users\\test\\AppData\\Local\\WTM\\logs', ownerOnly: true },
    ]);
  });
});
