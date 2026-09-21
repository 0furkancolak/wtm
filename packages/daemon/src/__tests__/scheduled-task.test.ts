/**
 * `createServiceLifecycle`'s uid resolution against the Windows Scheduled Task backend, which has
 * no POSIX uid at all.
 *
 * This cannot run a real `schtasks.exe` (`../__tests__/systemd.test.ts`'s own comment on
 * `windows-latest` describes the same limitation for that backend's own file-lifecycle suite), and
 * a full `install()` against Windows-shaped paths (`C:\Users\...`) has no meaning on this host's
 * filesystem either. What is host-independent, and what regressed, is construction itself:
 * `createServiceLifecycle` used to compute `uid` from `process.getuid?.() ?? -1` unconditionally,
 * which threw `Task Scheduler uid must be a non-negative integer` on any host without
 * `process.getuid` before a single `schtasks.exe` argument vector was built -- every `wtm daemon`
 * subcommand refused on Windows, always. `process.getuid` is stubbed away here to reproduce that
 * host shape on any machine, POSIX included.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { linuxServiceBackend, windowsServiceBackend } from '@wtm/platform/service';
import type { ServiceCommandResult } from '@wtm/platform/service';
import { createServiceLifecycle } from '../service-lifecycle';

const originalGetuid = process.getuid;

afterEach(() => {
  if (originalGetuid === undefined) delete (process as { getuid?: () => number }).getuid;
  else process.getuid = originalGetuid;
});

function removeGetuid(): void {
  delete (process as { getuid?: () => number }).getuid;
}

const notFound: ServiceCommandResult = { outcome: 'not-found', exitCode: 1, stdout: '', stderr: '' };
const domainReachable: ServiceCommandResult = { outcome: 'success', exitCode: 0, stdout: 'STATE: RUNNING', stderr: '' };

/** `print` says the task is unknown; `printDomain` says Task Scheduler itself is reachable. */
async function absentButReachable(argv: readonly string[]): Promise<ServiceCommandResult> {
  return argv[0] === 'sc.exe' ? domainReachable : notFound;
}

describe('a service manager with no POSIX uid at all', () => {
  test('constructs and reports status without ever asking process.getuid for one', async () => {
    removeGetuid();

    const status = await createServiceLifecycle({
      backend: windowsServiceBackend,
      home: 'C:\\Users\\test',
      platform: 'win32',
      programArguments: ['C:\\wtm\\wtm.exe', 'daemon', 'serve'],
      commandRunner: absentButReachable,
    }).status();

    expect(status.state).toBe('absent');
  });

  test('still lets an explicit uid through unchanged, for a caller that has one to give', async () => {
    removeGetuid();

    const status = await createServiceLifecycle({
      backend: windowsServiceBackend,
      home: 'C:\\Users\\test',
      platform: 'win32',
      uid: 1000,
      programArguments: ['C:\\wtm\\wtm.exe', 'daemon', 'serve'],
      commandRunner: absentButReachable,
    }).status();

    expect(status.state).toBe('absent');
  });
});

/**
 * The other side of the same fix: a backend whose domain genuinely is keyed by a POSIX uid
 * (`backend.usesUid` defaults to `true`, which is every backend before this field existed) must
 * still refuse to guess one. Proves the Windows fix narrowed the exception to backends that
 * declare they do not need a uid, rather than silencing the check everywhere.
 */
describe('a service manager whose domain is keyed by a POSIX uid', () => {
  test('still refuses to construct without one, exactly as before', () => {
    removeGetuid();

    expect(() => createServiceLifecycle({
      backend: linuxServiceBackend,
      home: '/home/test',
      platform: 'linux',
      programArguments: ['/opt/wtm/cli.js', 'daemon', 'serve'],
      commandRunner: absentButReachable,
    })).toThrow('systemd uid must be a non-negative integer');
  });
});
