# Item 45 — Daemon Startup Crash Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After this change, a daemon that cannot start either recovers by itself or stops with one actionable, coded reason. It no longer loops forever. `wtm doctor` and `wtm daemon install` both say why it is down.

**Architecture:** There are four independent mechanisms, each of which closes one gap:
1. The Unix IPC publisher classifies whatever occupies the socket path. It reclaims only WTM's own stale close-shield placeholder and refuses everything else with `WTM_IPC_PATH_UNUSABLE`.
2. `daemon serve` knows whether a service manager is watching it. When one is and the failure is permanent, it exits 0 so the manager stops restarting it. Both service definitions state the same retry interval.
3. Every startup writes its outcome to one rewritten file, `daemon-status.json`. That file de-duplicates frames across launches and feeds `doctor` and `install`.
4. The daemon's own log files are rotated at startup.

**Tech Stack:** TypeScript on Node 24 / Bun 1.3, `bun:test`, zod, launchd plist and systemd unit rendering.

**Spec:** `docs/superpowers/specs/2026-09-09-daemon-startup-crash-loop.md`. Read the "Revisions after reading the code" section first: R1–R5 there override the earlier decisions, and this plan implements the revised decisions.

## Global Constraints

- New stable error code: exactly `WTM_IPC_PATH_UNUSABLE`, exit class **2**. It is registered in `packages/protocol/src/errors.ts` and documented in `docs/18-errors-json-contract.md`. `packages/protocol/src/__tests__/errors.test.ts` fails if the code is missing from docs/18.
- A close-shield placeholder is reclaimable only if all of these hold: regular file, owned by the current uid, `size === 0`, `mode & 0o777 === 0o600`, `nlink === 1`, and `Date.now() - mtimeMs >= 30_000`.
- The supervision marker is the environment variable `WTM_DAEMON_SUPERVISED=1`, set by both service definitions and by nothing else.
- Restart policy: plist `ThrottleInterval` = `10`. Unit: `RestartSec=10`, and `StartLimitIntervalSec=0` in `[Unit]`.
- The status file is `daemon-status.json` in the service `logRoot`. It is written by temp-file plus rename, at mode 0600. Every read and write is best effort and never throws.
- Daemon log rotation reuses `ManagedLogStore`'s defaults: 20 MiB, 3 retained generations.
- Windows is out of scope (Increment D2 is paused). `packages/platform/src/ipc/windows.ts` is untouched.
- The test runner for every step is `bun test --timeout 60000 <file>`. The full suite, run at the end, is `bun run typecheck && bun run lint && bun run test`.
- Every commit message ends with the repository's standard `Co-Authored-By` trailer.

---

### Task 1: Register `WTM_IPC_PATH_UNUSABLE` and its error class

**Files:**
- Create: `packages/platform/src/ipc/path-unusable.ts`
- Create: `packages/platform/src/ipc/__tests__/path-unusable.test.ts`
- Modify: `packages/platform/src/ipc/index.ts`
- Modify: `packages/protocol/src/errors.ts:10` (the `'WTM_…'` line of `wtmErrorCodeSchema`)
- Modify: `packages/cli/src/exit-codes.ts` (the exit-2 group)
- Modify: `packages/cli/src/__tests__/exit-codes.test.ts:35` (the expected table)
- Modify: `docs/18-errors-json-contract.md` (the code list near line 104, and a paragraph after the `WTM_SOCKET_PATH_TOO_LONG` paragraph)

**Interfaces:**
- Produces: `type IpcPathOccupant = 'file' | 'foreign-file' | 'directory' | 'symlink' | 'foreign-socket' | 'other'`, and `class IpcPathUnusableError extends Error` with `code: 'WTM_IPC_PATH_UNUSABLE'`, `severity: 'error'`, `context: { path: string; occupant: IpcPathOccupant; ownerUid: number | null }` and `remediation: readonly Remediation[]`. The constructor is `new IpcPathUnusableError(path: string, occupant: IpcPathOccupant, ownerUid: number | null)`. Both are exported from `@wtm/platform/ipc`.

- [ ] **Step 1: Write the failing test**

`packages/platform/src/ipc/__tests__/path-unusable.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { wtmErrorCodeSchema } from '@wtm/protocol';
import { IpcPathUnusableError } from '../path-unusable';

describe('IpcPathUnusableError', () => {
  test('carries a registered code, the path, the occupant and the owner', () => {
    const error = new IpcPathUnusableError('/tmp/x/.tmd.sock', 'file', 501);
    expect(wtmErrorCodeSchema.parse(error.code)).toBe('WTM_IPC_PATH_UNUSABLE');
    expect(error.severity).toBe('error');
    expect(error.context).toEqual({ path: '/tmp/x/.tmd.sock', occupant: 'file', ownerUid: 501 });
    expect(error.message).toContain('/tmp/x/.tmd.sock');
  });

  test('offers `rm` only where removing the path is the remedy', () => {
    expect(new IpcPathUnusableError('/p', 'file', 1).remediation)
      .toEqual([{ kind: 'command-suggestion', argv: ['rm', '/p'] }]);
    expect(new IpcPathUnusableError('/p', 'symlink', 1).remediation)
      .toEqual([{ kind: 'command-suggestion', argv: ['rm', '/p'] }]);
    for (const occupant of ['foreign-file', 'directory', 'foreign-socket', 'other'] as const) {
      expect(new IpcPathUnusableError('/p', occupant, 1).remediation)
        .toEqual([{ kind: 'command-suggestion', argv: ['wtm', 'doctor'] }]);
    }
  });

  test('never tells the user to remove something that belongs to someone else', () => {
    expect(new IpcPathUnusableError('/p', 'foreign-file', 0).message).toContain('will not remove');
    expect(new IpcPathUnusableError('/p', 'foreign-socket', 0).message).toContain('will not remove');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun test --timeout 60000 packages/platform/src/ipc/__tests__/path-unusable.test.ts`
Expected: FAIL. The module `../path-unusable` cannot be resolved.

- [ ] **Step 3: Implement the class and register the code**

`packages/platform/src/ipc/path-unusable.ts`:

```ts
import type { Remediation } from '@wtm/protocol';

/** What was found at a socket path the daemon could not use. */
export type IpcPathOccupant = 'file' | 'foreign-file' | 'directory' | 'symlink' | 'foreign-socket' | 'other';

/**
 * Raised instead of a bare `Error` when the daemon's socket path is occupied by something it will
 * not reclaim (spec `2026-09-09-daemon-startup-crash-loop.md`, decision 2 and R1).
 *
 * It carries a `WtmErrorCode`, so `daemon serve`'s `codedError` puts it in the envelope as is, and
 * its exit class (2) is what makes a supervised daemon stop retrying it.
 */
export class IpcPathUnusableError extends Error {
  readonly code = 'WTM_IPC_PATH_UNUSABLE' as const;
  readonly severity = 'error' as const;
  readonly context: { path: string; occupant: IpcPathOccupant; ownerUid: number | null };
  readonly remediation: readonly Remediation[];

  constructor(path: string, occupant: IpcPathOccupant, ownerUid: number | null) {
    super(messageFor(path, occupant));
    this.name = 'IpcPathUnusableError';
    this.context = { path, occupant, ownerUid };
    // Removing the path is the remedy only for a file of ours or a link (unlinking a link never
    // touches its target). Anything else needs a person to look first.
    this.remediation = occupant === 'file' || occupant === 'symlink'
      ? [{ kind: 'command-suggestion', argv: ['rm', path] }]
      : [{ kind: 'command-suggestion', argv: ['wtm', 'doctor'] }];
  }
}

function messageFor(path: string, occupant: IpcPathOccupant): string {
  switch (occupant) {
    case 'file':
      return `The WTM daemon socket path is occupied by a file WTM did not leave there: ${path}. `
        + 'Remove it, then run `wtm daemon install` to start the daemon again.';
    case 'symlink':
      return `The WTM daemon socket path is a symbolic link: ${path}. WTM will not follow it. `
        + 'Remove the link, then run `wtm daemon install`.';
    case 'foreign-file':
      return `The WTM daemon socket path holds a file owned by another user: ${path}. WTM will not `
        + 'remove it. The directory is meant to be private to you, so find out how it got there.';
    case 'foreign-socket':
      return `The WTM daemon socket path holds a socket owned by another user: ${path}. WTM will not remove it.`;
    case 'directory':
      return `The WTM daemon socket path is a directory: ${path}. WTM will not remove a directory. `
        + 'Move it aside, then run `wtm daemon install`.';
    case 'other':
      return `The WTM daemon socket path holds something that is neither a socket nor a file: ${path}. `
        + 'WTM will not remove it.';
  }
}
```

`packages/platform/src/ipc/index.ts`: add these lines.

```ts
export { IpcPathUnusableError } from './path-unusable';
export type { IpcPathOccupant } from './path-unusable';
```

`packages/protocol/src/errors.ts`: in the `'WTM_NOT_INITIALIZED', …` line, insert `'WTM_IPC_PATH_UNUSABLE',` directly after `'WTM_SOCKET_PATH_TOO_LONG',`.

`packages/cli/src/exit-codes.ts`: in the exit-2 condition, directly after `|| code === 'WTM_SOCKET_PATH_TOO_LONG'`, add:

```ts
    // Something occupies the daemon's socket path that WTM will not remove. A retry finds the same
    // occupant; only a person can clear it, which is the class a supervised daemon stops on.
    || code === 'WTM_IPC_PATH_UNUSABLE'
```

`packages/cli/src/__tests__/exit-codes.test.ts`: after `WTM_SOCKET_PATH_TOO_LONG: 2,`, add `WTM_IPC_PATH_UNUSABLE: 2,`.

`docs/18-errors-json-contract.md`: in the fenced code list, add `WTM_IPC_PATH_UNUSABLE` after `WTM_SOCKET_PATH_TOO_LONG`. After the `WTM_SOCKET_PATH_TOO_LONG` paragraph, add:

```markdown
`WTM_IPC_PATH_UNUSABLE` means the daemon's socket path, published or private, is occupied by
something WTM will not remove: a non-empty file, a symbolic link, a directory, or a file or
socket owned by another user. WTM reclaims only a stale socket of its own and the empty
placeholder file its own shutdown leaves behind when it is killed mid-close. `context` carries
`path`, `occupant` (`file`, `foreign-file`, `directory`, `symlink`, `foreign-socket` or `other`)
and `ownerUid`. The remediation is `rm <path>` where removing the path is the remedy, and
`wtm doctor` where it is not. A daemon run by launchd or systemd stops retrying on this code
instead of restarting forever. It is a condition a person has to clear, so it exits with code 2.
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `bun test --timeout 60000 packages/platform/src/ipc/__tests__/path-unusable.test.ts packages/cli/src/__tests__/exit-codes.test.ts packages/protocol/src/__tests__/errors.test.ts`
Expected: PASS. Then run `bun run typecheck`. Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/platform/src/ipc packages/protocol/src/errors.ts packages/cli/src/exit-codes.ts packages/cli/src/__tests__/exit-codes.test.ts docs/18-errors-json-contract.md
git commit -m "feat: register WTM_IPC_PATH_UNUSABLE for a socket path WTM will not reclaim (item 45)"
```

---

### Task 2: Classify the socket-path occupant; reclaim only a stale shield placeholder

**Files:**
- Modify: `packages/platform/src/ipc/unix.ts:295-361` (`prepareSocketPath`, `quarantineAndUnlink`)
- Test: `packages/daemon/src/__tests__/server.integration.test.ts` (two existing tests at ~425 and ~547, plus new tests beside them)

**Interfaces:**
- Consumes: `IpcPathUnusableError` from Task 1 (import it from `./path-unusable`).
- Produces: `export const staleShieldPlaceholderMs = 30_000` from `unix.ts`. A starting daemon that finds a *young* placeholder throws a plain `Error` whose message contains `too recent to reclaim`. Task 3 relies on this: it is transient, so it is retried.

- [ ] **Step 1: Write the failing tests**

In `server.integration.test.ts`, extend the `node:fs/promises` import with `mkdir, symlink, utimes`. Inside the `'Unix IPC server and client'` describe, next to `'preserves a non-socket deterministic private bind path and fails startup'`, add:

```ts
  test('reclaims a stale close-shield placeholder at the private bind path and starts', async () => {
    expect(serverModule).not.toBeNull();
    if (serverModule === null) return;
    const path = await socketPath();
    const privatePath = expectedPrivateSocketPath(path);
    // Exactly what a daemon killed mid-close leaves behind: empty, 0600, ours, and old.
    await writeFile(privatePath, '', { mode: 0o600 });
    await chmod(privatePath, 0o600);
    const old = new Date(Date.now() - 60_000);
    await utimes(privatePath, old, old);
    const server = new serverModule.UnixIpcServer({
      socketPath: path,
      handler: async (value) => success(value.command, null),
    });
    cleanups.push(() => server.close());

    await server.start();
    expect((await lstat(path)).isSocket()).toBeTrue();
    await expect(lstat(privatePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('leaves a placeholder that is too young alone, and fails as transient rather than coded', async () => {
    expect(serverModule).not.toBeNull();
    if (serverModule === null) return;
    const path = await socketPath();
    const privatePath = expectedPrivateSocketPath(path);
    await writeFile(privatePath, '', { mode: 0o600 });
    await chmod(privatePath, 0o600);
    const server = new serverModule.UnixIpcServer({
      socketPath: path,
      handler: async (value) => success(value.command, null),
    });
    cleanups.push(() => server.close());

    const failure = await server.start().then(() => null, (error: unknown) => error);
    expect(String((failure as Error).message)).toContain('too recent to reclaim');
    expect((failure as { code?: unknown }).code).toBeUndefined();
    expect((await lstat(privatePath)).isFile()).toBeTrue();
  });

  test('refuses a directory at the published path with a coded, actionable error', async () => {
    expect(serverModule).not.toBeNull();
    if (serverModule === null) return;
    const path = await socketPath();
    await mkdir(path);
    const server = new serverModule.UnixIpcServer({
      socketPath: path,
      handler: async (value) => success(value.command, null),
    });
    cleanups.push(() => server.close());

    await expect(server.start()).rejects.toMatchObject({
      code: 'WTM_IPC_PATH_UNUSABLE',
      context: { path, occupant: 'directory' },
      remediation: [{ kind: 'command-suggestion', argv: ['wtm', 'doctor'] }],
    });
    expect((await lstat(path)).isDirectory()).toBeTrue();
  });

  test('refuses a symbolic link at the published path without touching its target', async () => {
    expect(serverModule).not.toBeNull();
    if (serverModule === null) return;
    const path = await socketPath();
    const target = join(dirname(path), 'target');
    await writeFile(target, 'target content');
    await symlink(target, path);
    const server = new serverModule.UnixIpcServer({
      socketPath: path,
      handler: async (value) => success(value.command, null),
    });
    cleanups.push(() => server.close());

    await expect(server.start()).rejects.toMatchObject({
      code: 'WTM_IPC_PATH_UNUSABLE',
      context: { occupant: 'symlink' },
    });
    expect((await lstat(path)).isSymbolicLink()).toBeTrue();
    expect(await Bun.file(target).text()).toBe('target content');
  });
```

Change the two existing assertions. Both occupants are non-empty, so R1 keeps them refused; only the error changes.
- In `'preserves a non-socket deterministic private bind path and fails startup'`, replace `await expect(server.start()).rejects.toThrow('not a Unix socket');` with:
  ```ts
  await expect(server.start()).rejects.toMatchObject({
    code: 'WTM_IPC_PATH_UNUSABLE',
    context: { path: privatePath, occupant: 'file' },
    remediation: [{ kind: 'command-suggestion', argv: ['rm', privatePath] }],
  });
  ```
- In `'does not replace a non-socket path and rejects pending requests on close'`, replace `await expect(blocked.start()).rejects.toThrow('not a Unix socket');` with:
  ```ts
  await expect(blocked.start()).rejects.toMatchObject({ code: 'WTM_IPC_PATH_UNUSABLE', context: { occupant: 'file' } });
  ```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test --timeout 60000 packages/daemon/src/__tests__/server.integration.test.ts`
Expected: FAIL. The new tests and the two edited ones reject with `IPC path exists and is not a Unix socket`. The stale-placeholder test fails the same way.

- [ ] **Step 3: Implement the classification**

In `unix.ts`, add `import { IpcPathUnusableError, type IpcPathOccupant } from './path-unusable';`. Replace `prepareSocketPath` (295-324) with:

```ts
/**
 * How old a close-shield placeholder must be before a starting daemon treats it as litter.
 *
 * The shield (`closeServerWithPrivatePathShield`) puts exactly this file at the bound path for the
 * few milliseconds a server takes to close, and a daemon starting in that window finds the
 * published socket already refusing connections. Reclaiming a young placeholder would undo the
 * shield. A daemon killed mid-close leaves one that only ages. The service manager's retry
 * interval (10 s) is what makes waiting it out cheap (spec R1).
 */
export const staleShieldPlaceholderMs = 30_000;

async function prepareSocketPath(
  path: string,
  parent: DirectoryIdentity,
  hooks: {
    probe: (path: string) => Promise<boolean>;
    beforeQuarantine: () => Promise<void> | void;
  },
): Promise<void> {
  let initial;
  try {
    initial = await lstat(path);
  } catch (error) {
    if (isFileError(error, 'ENOENT')) return;
    throw error;
  }
  const currentUid = process.getuid?.();
  const ours = currentUid !== undefined && initial.uid === currentUid;
  if (initial.isSocket()) {
    if (!ours) throw new IpcPathUnusableError(path, 'foreign-socket', initial.uid);
    if (await hooks.probe(path)) throw new Error(`IPC socket is already in use: ${path}`);
    await quarantineAndUnlink(path, parent, {
      dev: initial.dev,
      ino: initial.ino,
      uid: initial.uid,
    }, {
      beforeQuarantine: hooks.beforeQuarantine,
      mismatchMessage: `IPC socket changed while checking stale ownership: ${path}`,
    });
    return;
  }
  if (ours && isShieldPlaceholderShape(initial)) {
    if (Date.now() - initial.mtimeMs < staleShieldPlaceholderMs) {
      // Deliberately uncoded: this is transient, and a coded class-2 failure would stop a
      // supervised daemon from ever retrying past it.
      throw new Error(`IPC path holds a close-shield placeholder too recent to reclaim: ${path}`);
    }
    const expected = { dev: initial.dev, ino: initial.ino, uid: initial.uid };
    await quarantineAndUnlink(path, parent, expected, {
      mismatchMessage: `IPC path changed while reclaiming a stale close-shield placeholder: ${path}`,
      matches: (stat) => isShieldPlaceholderShape(stat) && matchesPathIdentity(stat, expected),
    });
    return;
  }
  throw new IpcPathUnusableError(path, occupantOf(initial, ours), initial.uid);
}

/** The exact file `installClosePlaceholder` creates, and nothing wider. */
function isShieldPlaceholderShape(stat: Awaited<ReturnType<typeof lstat>>): boolean {
  return stat.isFile() && stat.size === 0 && (stat.mode & 0o777) === 0o600 && stat.nlink === 1;
}

function occupantOf(stat: Awaited<ReturnType<typeof lstat>>, ours: boolean): IpcPathOccupant {
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return ours ? 'file' : 'foreign-file';
  return 'other';
}
```

Generalise `quarantineAndUnlink`'s identity check. The rename-verify-unlink sequence is not socket-specific. In its options type, add `matches?: (stat: Awaited<ReturnType<typeof lstat>>) => boolean;`. Then replace `if (!matchesSocketIdentity(candidate, expected)) {` with:

```ts
  const matches = options.matches ?? ((stat) => matchesSocketIdentity(stat, expected));
  if (!matches(candidate)) {
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `bun test --timeout 60000 packages/daemon/src/__tests__/server.integration.test.ts packages/daemon/src/__tests__/runtime-factory.test.ts`
Expected: PASS, the whole file included. The close-shield tests at ~223–350 must be untouched and green. `bun run typecheck` must exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/platform/src/ipc/unix.ts packages/daemon/src/__tests__/server.integration.test.ts
git commit -m "fix: reclaim a stale close-shield placeholder and refuse other occupants with a code (item 45)"
```

---

### Task 3: Stop retrying a permanent failure, and state the restart policy

**Files:**
- Modify: `packages/cli/src/commands/daemon.ts` (`DaemonServeDependencies`, `serveDaemon`'s startup `catch`, a new `isPermanentStartupFailure`)
- Modify: `packages/cli/src/main.ts:410-426` (`serve.action`)
- Modify: `packages/platform/src/service/darwin.ts:167-172` (template) and `:334` (environment)
- Modify: `packages/platform/src/service/linux.ts:175-195` (unit template)
- Test: `packages/cli/src/commands/__tests__/daemon.test.ts`, `packages/daemon/src/__tests__/launchd.test.ts:84-88`, `packages/platform/src/service/__tests__/linux-service.test.ts:88-104`, `packages/platform/src/service/__tests__/darwin-service.test.ts`
- Modify: `docs/05-daemon-and-macos-runtime.md` (the passage that mentions `KeepAlive`)

**Interfaces:**
- Produces: `DaemonServeDependencies.supervised?: boolean`, and `function isPermanentStartupFailure(result: DaemonServeResult): boolean`, which Task 4 reuses.

- [ ] **Step 1: Write the failing tests**

In `daemon.test.ts`, after `'a coded startup failure keeps its code, …'`, add:

```ts
  test('under a service manager, a permanent failure exits 0 so it is not restarted forever', async () => {
    const failure = new DaemonSocketPathTooLongError(measureDaemonSocketPath(overLimitOnDarwin, darwinSocketPathLimitBytes));
    const supervised = await serveDaemon({
      runtimeFactory: async () => { throw failure; },
      signals: new FakeSignals(),
      reportError: () => {},
      supervised: true,
    });
    // The envelope still says exactly what went wrong; only the status the manager reads changes.
    expect(supervised.exitCode).toBe(0);
    expect(supervised.envelope.errors[0]?.code).toBe('WTM_SOCKET_PATH_TOO_LONG');

    const byHand = await serveDaemon({
      runtimeFactory: async () => { throw failure; },
      signals: new FakeSignals(),
      reportError: () => {},
    });
    expect(byHand.exitCode).toBe(2);
  });

  test('under a service manager, a transient failure still exits non-zero and is retried', async () => {
    const result = await serveDaemon({
      runtimeFactory: async () => { throw new Error('IPC path holds a close-shield placeholder too recent to reclaim: /x'); },
      signals: new FakeSignals(),
      reportError: () => {},
      supervised: true,
    });
    expect(result.exitCode).toBe(1);
  });
```

In `launchd.test.ts`, the deterministic plist fixture: after the `KeepAlive` `</dict>` line (88), insert:

```
  <key>ThrottleInterval</key>
  <integer>10</integer>
```

In `linux-service.test.ts`, the unit fixture:
- After `Documentation=https://github.com/0furkancolak/wtm`, insert `StartLimitIntervalSec=0`.
- Change the `Environment=` line to end `"PATH=/usr/bin:/bin" "WTM_DAEMON_SUPERVISED=1"`.
- Change `RestartSec=1` to `RestartSec=10`.

In `darwin-service.test.ts`, add:

```ts
  test('marks the daemon as supervised, which is what lets a permanent failure stop the restarts', () => {
    const plist = darwinServiceBackend.renderDefinition({
      label: 'dev.wtm.daemon.test',
      executable: '/opt/wtm/bin/wtm',
      args: ['daemon', 'serve'],
      workingDirectory: '/Users/test',
      standardOutPath: '/Users/test/Library/Logs/WTM/daemon.log',
      standardErrorPath: '/Users/test/Library/Logs/WTM/daemon.error.log',
      home: '/Users/test',
      pathEnvironment: '/usr/bin:/bin',
    });
    expect(plist).toContain('<key>WTM_DAEMON_SUPERVISED</key>\n    <string>1</string>');
    expect(plist).toContain('<key>ThrottleInterval</key>\n  <integer>10</integer>');
  });
```

If `renderDefinition`'s option type (`ServiceDefinitionOptions` in `packages/platform/src/service/types.ts`) names a field differently from the object above, use the field names from `types.ts`. The assertions do not change.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test --timeout 60000 packages/cli/src/commands/__tests__/daemon.test.ts packages/daemon/src/__tests__/launchd.test.ts packages/platform/src/service/__tests__/linux-service.test.ts packages/platform/src/service/__tests__/darwin-service.test.ts`
Expected: FAIL. The supervised test gets 2 instead of 0, and the fixtures differ by the new lines.

- [ ] **Step 3: Implement**

In `daemon.ts`, add to `DaemonServeDependencies`:

```ts
  /**
   * Whether a service manager started this process (`WTM_DAEMON_SUPERVISED=1`, which only the
   * launchd and systemd definitions set). A permanent startup failure then exits 0: both managers
   * restart only a non-zero exit, and retrying a condition a person has to clear is the loop that
   * wrote 162 MB of log in a week (spec R2). Run by hand, the exit keeps its normal class.
   */
  supervised?: boolean;
```

In `serveDaemon`'s startup `catch`, replace `return serveFailure('WTM daemon could not start.', error);` with:

```ts
      const failed = serveFailure('WTM daemon could not start.', error);
      return dependencies.supervised === true && isPermanentStartupFailure(failed)
        ? { ...failed, exitCode: 0 }
        : failed;
```

Below `startupFailureExitCode`, add:

```ts
/**
 * A startup failure no retry can clear: a coded error in exit class 2, the class for
 * configuration a person has to change. Not a second list, so a code classified there later is
 * treated as permanent here without this function changing.
 */
export function isPermanentStartupFailure(result: DaemonServeResult): boolean {
  const code = result.envelope.errors[0]?.code;
  return code !== undefined && exitCodeForError(code) === 2;
}
```

In `main.ts` `serve.action`, add to the object passed to `serveDaemon`: `supervised: process.env.WTM_DAEMON_SUPERVISED === '1',`.

In `darwin.ts:334`, change the environment to `environment: { HOME: options.home, PATH: options.pathEnvironment, WTM_DAEMON_SUPERVISED: '1' },` and update the comment above it: the agent inherits exactly these three variables. In the plist template, directly after the `KeepAlive` `</dict>` line, add:

```
  <key>ThrottleInterval</key>
  <integer>10</integer>
```

In `linux.ts`'s template:
- Add `StartLimitIntervalSec=0` as the last line of `[Unit]`.
- Append ` "WTM_DAEMON_SUPERVISED=1"` to the `Environment=` line.
- Change `RestartSec=1` to `RestartSec=10`.
- Extend the comment above the template: `StartLimitIntervalSec=0` and `RestartSec=10` state launchd's policy (retry transient failures every 10 s, indefinitely) instead of inheriting the distro's rate limit. Permanent failures are no longer retried at all, because they exit 0.

In `docs/05-daemon-and-macos-runtime.md`, next to the existing `KeepAlive` description, add one paragraph stating: the retry interval (10 s on both platforms); that a permanent startup failure exits 0 when `WTM_DAEMON_SUPERVISED=1`, so the manager leaves the daemon stopped; and that `wtm doctor` then reports the recorded reason, with `wtm daemon install` starting the daemon again.

- [ ] **Step 4: Run the tests and confirm they pass**

Run the Step 2 command again. Expected: PASS. If `packages/daemon/src/__tests__/service-lifecycle*.test.ts` or another test snapshots a whole plist or unit, update only the three changed lines in it. Find such tests with `grep -rln "RestartSec=1\|SuccessfulExit" packages --include='*.test.ts'`.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/daemon.ts packages/cli/src/main.ts packages/platform/src/service packages/daemon/src/__tests__/launchd.test.ts packages/cli/src/commands/__tests__/daemon.test.ts docs/05-daemon-and-macos-runtime.md
git commit -m "fix: a supervised daemon stops on a permanent startup failure; state one restart policy (item 45)"
```

---

### Task 4: Record every startup outcome in `daemon-status.json`, and stop re-writing frames across launches

**Files:**
- Create: `packages/cli/src/daemon-status.ts`
- Create: `packages/cli/src/__tests__/daemon-status.test.ts`
- Modify: `packages/cli/src/commands/daemon.ts` (`createDaemonErrorReporter`, `serveDaemon`)
- Modify: `packages/cli/src/main.ts` (`serve.action`)
- Modify: `packages/daemon/src/main.ts:683-700` (`missingDirectory`)
- Test: `packages/cli/src/commands/__tests__/daemon.test.ts`

**Interfaces:**
- Consumes: `isPermanentStartupFailure` (Task 3).
- Produces, from `packages/cli/src/daemon-status.ts`:
  - `type DaemonStartupOutcome = { started: true } | { started: false; code: WtmErrorCode; condition: string; message: string; remediation: string[] | null; permanent: boolean }`
  - `type DaemonStatus` (the zod schema's type: `schemaVersion: 1`, `state: 'running' | 'failed'`, `at`, `pid`, `since`, `attempts`, `code: string | null`, `condition: string | null`, `message: string | null`, `remediation: string[] | null`, `permanent`)
  - `daemonStatusPath(logRoot: string): string`
  - `servicePathsForHost(): ServicePaths | null`
  - `readDaemonStatus(path: string): DaemonStatus | null`
  - `writeDaemonStatus(path: string, status: DaemonStatus): void`
  - `nextDaemonStatus(previous: DaemonStatus | null, outcome: DaemonStartupOutcome, now: Date, pid: number): DaemonStatus`
  - `formatRemediation(argv: readonly string[]): string`
- Produces: `DaemonServeDependencies.recordOutcome?: (outcome: DaemonStartupOutcome) => void`. `createDaemonErrorReporter` gains a fourth parameter, `options: { repeatedCondition?: string | null } = {}`.

- [ ] **Step 1: Write the failing tests**

`packages/cli/src/__tests__/daemon-status.test.ts`:

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonStatusPath, formatRemediation, nextDaemonStatus, readDaemonStatus, writeDaemonStatus } from '../daemon-status';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'wtm-status-'));
  roots.push(path);
  return path;
}

const failure = {
  started: false as const, code: 'WTM_IPC_PATH_UNUSABLE' as const, condition: 'The WTM daemon socket path is a directory: /x.',
  message: 'The WTM daemon socket path is a directory: /x.', remediation: ['wtm', 'doctor'], permanent: true,
};

describe('daemon-status.json', () => {
  test('round-trips through one private file', () => {
    const path = daemonStatusPath(root());
    const status = nextDaemonStatus(null, failure, new Date('2026-09-11T10:00:00.000Z'), 42);
    writeDaemonStatus(path, status);
    expect(readDaemonStatus(path)).toEqual(status);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('reads a missing or corrupt file as no status, never as an exception', () => {
    const path = daemonStatusPath(root());
    expect(readDaemonStatus(path)).toBeNull();
    writeFileSync(path, '{not json');
    expect(readDaemonStatus(path)).toBeNull();
  });

  test('counts a repeated condition from its first occurrence, and restarts the count on a new one', () => {
    const first = nextDaemonStatus(null, failure, new Date('2026-09-11T10:00:00.000Z'), 1);
    const second = nextDaemonStatus(first, failure, new Date('2026-09-11T10:00:10.000Z'), 2);
    expect(second).toMatchObject({ state: 'failed', since: '2026-09-11T10:00:00.000Z', attempts: 2, pid: 2 });
    const other = nextDaemonStatus(second, { ...failure, condition: 'another' }, new Date('2026-09-11T10:00:20.000Z'), 3);
    expect(other).toMatchObject({ since: '2026-09-11T10:00:20.000Z', attempts: 1 });
    const running = nextDaemonStatus(other, { started: true }, new Date('2026-09-11T10:00:30.000Z'), 4);
    expect(running).toMatchObject({ state: 'running', code: null, condition: null, attempts: 1 });
  });

  test('formats a remediation so a path with spaces survives being pasted into a shell', () => {
    expect(formatRemediation(['rm', '/Users/a/Library/Application Support/WTM/.tmd.sock']))
      .toBe("rm '/Users/a/Library/Application Support/WTM/.tmd.sock'");
    expect(formatRemediation(['wtm', 'doctor'])).toBe('wtm doctor');
  });
});
```

In `daemon.test.ts`, in the describe that holds `'starts in the foreground, handles the first signal, closes once, and removes listeners'`, add:

```ts
  test('records the outcome of every startup, successful or not', async () => {
    const outcomes: DaemonStartupOutcome[] = [];
    const signals = new FakeSignals();
    const serving = serveDaemon({
      runtimeFactory: async () => ({ start: async () => {}, close: async () => {} }),
      signals,
      recordOutcome: (outcome) => { outcomes.push(outcome); },
    });
    await until(() => signals.listenerCount() === 2 && outcomes.length === 1);
    signals.emit('SIGTERM');
    await serving;
    expect(outcomes).toEqual([{ started: true }]);

    const failure = new DaemonSocketPathTooLongError(measureDaemonSocketPath(overLimitOnDarwin, darwinSocketPathLimitBytes));
    const failed: DaemonStartupOutcome[] = [];
    await serveDaemon({
      runtimeFactory: async () => { throw failure; },
      signals: new FakeSignals(),
      reportError: () => {},
      recordOutcome: (outcome) => { failed.push(outcome); },
    });
    expect(failed).toEqual([{
      started: false, code: 'WTM_SOCKET_PATH_TOO_LONG', condition: failure.message, message: failure.message,
      remediation: ['wtm', 'doctor'], permanent: true,
    }]);
  });
```

In `describe('daemon failure output', …)`, add:

```ts
  test('frames are kept once per condition across launches, and never for a warning-grade condition', () => {
    const retained: string[] = [];
    const repeat = createDaemonErrorReporter(() => {}, () => 0, (entry) => { retained.push(entry); }, {
      repeatedCondition: 'socket path is a directory',
    });
    repeat(new Error('socket path is a directory'));
    expect(retained).toEqual([]);
    repeat(new Error('something new'));
    expect(retained).toHaveLength(1);

    const quiet = createDaemonErrorReporter(() => {}, () => 0, (entry) => { retained.push(entry); });
    quiet(Object.assign(new Error('Registered repository root is unavailable: /gone'), { retainFrames: false }));
    expect(retained).toHaveLength(1);
  });
```

Import `DaemonStartupOutcome` from `'../../daemon-status'` in `daemon.test.ts`. `until` is the helper the file already defines.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test --timeout 60000 packages/cli/src/__tests__/daemon-status.test.ts packages/cli/src/commands/__tests__/daemon.test.ts`
Expected: FAIL. `../daemon-status` cannot be resolved, and `recordOutcome` is never called.

- [ ] **Step 3: Implement**

`packages/cli/src/daemon-status.ts`:

```ts
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { selectPlatformRuntime } from '@wtm/platform';
import type { WtmErrorCode } from '@wtm/protocol';
import { servicePathsFor, type ServicePaths } from '@wtm/daemon/service-lifecycle';

/**
 * The one place a daemon that could not start leaves its reason (spec decision 4 and R4).
 *
 * One document, rewritten, never appended: it cannot grow, and it is the only record that
 * survives a crash loop, because every launch is a new process with an empty memory.
 */
export const daemonStatusFileName = 'daemon-status.json';

export type DaemonStartupOutcome =
  | { started: true }
  | {
    started: false;
    code: WtmErrorCode;
    /** The reporter's one-line condition: what repeats, and what de-duplication keys on. */
    condition: string;
    message: string;
    remediation: string[] | null;
    permanent: boolean;
  };

const daemonStatusSchema = z.object({
  schemaVersion: z.literal(1),
  state: z.enum(['running', 'failed']),
  at: z.string().datetime(),
  pid: z.number().int().positive(),
  since: z.string().datetime(),
  attempts: z.number().int().positive(),
  code: z.string().nullable(),
  condition: z.string().nullable(),
  message: z.string().nullable(),
  remediation: z.array(z.string()).min(1).nullable(),
  permanent: z.boolean(),
}).strict();

export type DaemonStatus = z.infer<typeof daemonStatusSchema>;

export function daemonStatusPath(logRoot: string): string {
  return join(logRoot, daemonStatusFileName);
}

/** This HOME's service paths on this host, or `null` on a host WTM has no backend for. */
export function servicePathsForHost(): ServicePaths | null {
  try {
    return servicePathsFor(selectPlatformRuntime().service, { home: homedir(), env: process.env });
  } catch {
    return null;
  }
}

export function readDaemonStatus(path: string): DaemonStatus | null {
  try {
    return daemonStatusSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

/** Best effort, like the error log: a status that cannot be written must not mask the failure. */
export function writeDaemonStatus(path: string, status: DaemonStatus): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${String(process.pid)}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(status)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    // Deliberately silent.
  }
}

export function nextDaemonStatus(
  previous: DaemonStatus | null,
  outcome: DaemonStartupOutcome,
  now: Date,
  pid: number,
): DaemonStatus {
  const at = now.toISOString();
  if (outcome.started) {
    return {
      schemaVersion: 1, state: 'running', at, pid, since: at, attempts: 1,
      code: null, condition: null, message: null, remediation: null, permanent: false,
    };
  }
  const repeat = previous !== null && previous.state === 'failed' && previous.condition === outcome.condition;
  return {
    schemaVersion: 1,
    state: 'failed',
    at,
    pid,
    since: repeat ? previous.since : at,
    attempts: repeat ? previous.attempts + 1 : 1,
    code: outcome.code,
    condition: outcome.condition,
    message: outcome.message,
    remediation: outcome.remediation,
    permanent: outcome.permanent,
  };
}

/** A remediation argv as a person would paste it: quoted only where the shell needs it. */
export function formatRemediation(argv: readonly string[]): string {
  return argv.map((word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`)).join(' ');
}
```

In `commands/daemon.ts`:
1. Add `import type { DaemonStartupOutcome } from '../daemon-status';`.
2. Add `recordOutcome?: (outcome: DaemonStartupOutcome) => void;` to `DaemonServeDependencies`, with a doc comment: it is called exactly once per startup.
3. In `serveDaemon`, directly after `await runtime.start();`, add `dependencies.recordOutcome?.({ started: true });`.
4. Replace the Task 3 `catch` body with:

```ts
      reportError(error);
      await closeOnce().catch(() => {});
      const failed = serveFailure('WTM daemon could not start.', error);
      const permanent = isPermanentStartupFailure(failed);
      const reported = failed.envelope.errors[0];
      if (reported !== undefined) {
        const condition = reportableCondition(error);
        dependencies.recordOutcome?.({
          started: false,
          code: reported.code,
          condition,
          // An uncoded failure's envelope message is deliberately generic; the local record is
          // not an envelope, and the condition is what tells a person what happened.
          message: reported.code === 'WTM_DAEMON_REQUEST_FAILED' ? condition : reported.message,
          remediation: reported.remediation?.[0]?.argv ?? null,
          permanent,
        });
      }
      return dependencies.supervised === true && permanent ? { ...failed, exitCode: 0 } : failed;
```

5. Change `createDaemonErrorReporter`'s signature and its frame retention to:

```ts
export function createDaemonErrorReporter(
  write: (line: string) => void = (line) => { process.stderr.write(line); },
  clock: () => number = () => Date.now(),
  retain: (entry: string) => void = appendToDaemonErrorLog,
  /**
   * The condition the previous launch already failed on, from `daemon-status.json`. Its frames
   * are in the log once already; a crash loop writing them again on every launch is how the
   * reported log reached 162 MB (spec R4).
   */
  options: { repeatedCondition?: string | null } = {},
): (error: unknown) => void {
```

   Then replace the last two lines of the returned function with:

```ts
    const frames = error instanceof Error ? error.stack : undefined;
    const warningGrade = isRecord(error) && error.retainFrames === false;
    if (!warningGrade && detail !== options.repeatedCondition && frames !== undefined && frames !== '') {
      retain(`${stamp} ${frames}\n`);
    }
```

In `main.ts` `serve.action`, replace `const reportError = createDaemonErrorReporter();` and extend the `serveDaemon` call:

```ts
    const service = servicePathsForHost();
    const statusPath = service === null ? null : daemonStatusPath(service.logRoot);
    const previous = statusPath === null ? null : readDaemonStatus(statusPath);
    const reportError = createDaemonErrorReporter(undefined, undefined, undefined, {
      repeatedCondition: previous?.state === 'failed' ? previous.condition : null,
    });
    const result = await serveDaemon({
      reportError,
      supervised: process.env.WTM_DAEMON_SUPERVISED === '1',
      ...(statusPath === null ? {} : {
        recordOutcome: (outcome: DaemonStartupOutcome) => {
          writeDaemonStatus(statusPath, nextDaemonStatus(previous, outcome, new Date(), process.pid));
        },
      }),
      runtimeFactory: /* unchanged */,
      /* signals: unchanged */
    });
```

Import `daemonStatusPath`, `nextDaemonStatus`, `readDaemonStatus`, `servicePathsForHost`, `writeDaemonStatus` and `type DaemonStartupOutcome` from `'./daemon-status'`.

In `packages/daemon/src/main.ts`, `missingDirectory`: wrap both `return new Error(…)` expressions in `Object.assign(new Error(…), { retainFrames: false as const })`. Add one comment above the function's first return: a missing root is a warning about the workspace, not a fault in the daemon, so its frames are worth nothing.

- [ ] **Step 4: Run the tests and confirm they pass**

Run the Step 2 command, plus `bun test --timeout 60000 packages/daemon/src/__tests__/main.test.ts` (or whichever daemon test covers `missingDirectory`; find it with `grep -rln "root is unavailable" packages/daemon/src/__tests__`).
Expected: PASS. `bun run typecheck` must exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/daemon-status.ts packages/cli/src/__tests__/daemon-status.test.ts packages/cli/src/commands/daemon.ts packages/cli/src/main.ts packages/daemon/src/main.ts packages/cli/src/commands/__tests__/daemon.test.ts
git commit -m "feat: record each daemon startup outcome and keep a failure's frames once across launches (item 45)"
```

---

### Task 5: Rotate the daemon's own logs at startup

**Files:**
- Modify: `packages/cli/src/commands/daemon.ts` (new `rotateDaemonServiceLogs`)
- Modify: `packages/cli/src/main.ts` (`serve.action`, before the status is read)
- Test: `packages/cli/src/commands/__tests__/daemon.test.ts`

**Interfaces:**
- Consumes: `servicePathsForHost` (Task 4). Also `ManagedLogStore` from `@wtm/daemon/logs` and `FileTrustPolicy` from `@wtm/platform/ports`.
- Produces: `rotateDaemonServiceLogs(paths: Pick<ServicePaths, 'logRoot' | 'stdoutPath' | 'stderrPath'>, fileTrust: FileTrustPolicy, rotationBytes?: number): Promise<void>`. It never throws.

- [ ] **Step 1: Write the failing test**

In `daemon.test.ts`, add a new describe:

```ts
describe('daemon log rotation', () => {
  test('rotates an over-size daemon log before the daemon writes to it, and keeps the old content', async () => {
    const logRoot = await mkdtemp(join(shortTmpRoot(), 'wtm-daemon-logs-'));
    try {
      const stderrPath = join(logRoot, 'daemon.error.log');
      const stdoutPath = join(logRoot, 'daemon.log');
      await writeFile(stderrPath, 'x'.repeat(2048), { mode: 0o600 });
      await rotateDaemonServiceLogs({ logRoot, stdoutPath, stderrPath }, selectPlatformRuntime().fileTrust, 1024);
      expect(await readFile(`${stderrPath}.1`, 'utf8')).toBe('x'.repeat(2048));
      await expect(lstat(stderrPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(logRoot, { recursive: true, force: true });
    }
  });

  test('a log root that cannot be rotated is not a reason to refuse to start', async () => {
    await rotateDaemonServiceLogs(
      { logRoot: '/nonexistent/wtm', stdoutPath: '/nonexistent/wtm/daemon.log', stderrPath: '/nonexistent/wtm/daemon.error.log' },
      selectPlatformRuntime().fileTrust,
    );
  });
});
```

Add `writeFile` to the file's `node:fs/promises` import, and import `rotateDaemonServiceLogs` from `'../daemon'`.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun test --timeout 60000 packages/cli/src/commands/__tests__/daemon.test.ts -t "daemon log rotation"`
Expected: FAIL. `rotateDaemonServiceLogs` is not exported.

- [ ] **Step 3: Implement**

In `commands/daemon.ts`:

```ts
import { ManagedLogStore } from '@wtm/daemon/logs';
import type { FileTrustPolicy } from '@wtm/platform/ports';
import type { ServicePaths } from '@wtm/daemon/service-lifecycle';

/**
 * Rotates the daemon's own stdout and stderr the way a managed task's logs are rotated (20 MiB,
 * three generations). It runs once per launch, before anything is written, and both service
 * managers reopen the path on the next launch. That bounds a loop that predates the fix,
 * including a 162 MB file already on disk (spec decision 5).
 */
export async function rotateDaemonServiceLogs(
  paths: Pick<ServicePaths, 'logRoot' | 'stdoutPath' | 'stderrPath'>,
  fileTrust: FileTrustPolicy,
  rotationBytes?: number,
): Promise<void> {
  try {
    const store = new ManagedLogStore({
      root: paths.logRoot,
      fileTrust,
      ...(rotationBytes === undefined ? {} : { rotationBytes }),
    });
    await store.rotate([paths.stderrPath, paths.stdoutPath]);
  } catch {
    // A log that cannot be rotated is not a reason to refuse to start.
  }
}
```

In `main.ts` `serve.action`, directly after `const service = servicePathsForHost();`, add:

```ts
    if (service !== null) await rotateDaemonServiceLogs(service, hostPlatformRuntime().fileTrust);
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `bun test --timeout 60000 packages/cli/src/commands/__tests__/daemon.test.ts`
Expected: PASS. `bun run typecheck` must exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/daemon.ts packages/cli/src/main.ts packages/cli/src/commands/__tests__/daemon.test.ts
git commit -m "fix: rotate the daemon's own logs at startup so no failure grows them without bound (item 45)"
```

---

### Task 6: `wtm doctor` reports why the daemon is down

**Files:**
- Modify: `packages/cli/src/state-diagnostics.ts` (`StateDiagnosticOptions`, `registrationFinding` at ~283-310)
- Test: `packages/cli/src/__tests__/state-diagnostics.test.ts` (the helpers at ~455-470, the message at ~220, new tests)

**Interfaces:**
- Consumes: `daemonStatusPath`, `readDaemonStatus`, `formatRemediation` (Task 4).
- Produces: `StateDiagnosticOptions.daemonStatusPath?: string`.

- [ ] **Step 1: Write the failing tests**

Change the helpers to accept a status path:

```ts
async function findingsAt(cwd: string, daemonSocketPath: string, daemonStatusPath?: string) {
  return (await createStateDiagnosticDataSource(store, {
    cwd,
    globalConfigPath: '/workspace/config.toml',
    daemonSocketPath,
    daemonStatusPath: daemonStatusPath ?? join(await tempDir(), 'daemon-status.json'),
  }).readDoctor(registered)).findings;
}

async function registrationFinding(cwd: string, daemonSocketPath: string, daemonStatusPath?: string) {
  return (await findingsAt(cwd, daemonSocketPath, daemonStatusPath)).find(({ check }) => check === 'registration');
}
```

Update the existing expectation at ~220 from `` 'Start it with `wtm daemon start`.' `` to `` 'Start it with `wtm daemon install`.' `` (R5: there is no `daemon start`).

Add:

```ts
  test('an unreachable daemon with a recorded startup failure is reported with its reason and its remedy', async () => {
    const statusPath = join(await tempDir(), 'daemon-status.json');
    writeDaemonStatus(statusPath, nextDaemonStatus(null, {
      started: false, code: 'WTM_IPC_PATH_UNUSABLE',
      condition: 'The WTM daemon socket path is a directory: /x.', message: 'The WTM daemon socket path is a directory: /x.',
      remediation: ['wtm', 'doctor'], permanent: true,
    }, new Date('2026-09-11T10:00:00.000Z'), 7));
    const finding = await registrationFinding('/workspace/web-feature', join(await tempDir(), 'absent.sock'), statusPath);

    expect(finding?.status).toBe('error');
    expect(finding?.message).toContain('The WTM daemon socket path is a directory: /x.');
    expect(finding?.message).toContain('since 2026-09-11T10:00:00.000Z');
    expect(finding?.message).toContain('`wtm daemon install`');
    expect(finding?.details).toMatchObject({
      code: 'WTM_IPC_PATH_UNUSABLE', daemonReachable: false,
      startupFailedSince: '2026-09-11T10:00:00.000Z', startupAttempts: 1, startupPermanent: true,
      startupRemediation: 'wtm doctor',
    });
  });

  test('a recorded successful start is not presented as the reason the daemon is down', async () => {
    const statusPath = join(await tempDir(), 'daemon-status.json');
    writeDaemonStatus(statusPath, nextDaemonStatus(null, { started: true }, new Date(), 7));
    const finding = await registrationFinding('/workspace/web-feature', join(await tempDir(), 'absent.sock'), statusPath);
    expect(finding?.status).toBe('warning');
    expect(finding?.details).toMatchObject({ code: 'WTM_DAEMON_UNAVAILABLE' });
  });
```

Import `nextDaemonStatus` and `writeDaemonStatus` from `'../daemon-status'`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test --timeout 60000 packages/cli/src/__tests__/state-diagnostics.test.ts`
Expected: FAIL. `daemonStatusPath` is not an option, and the message still names `daemon start`.

- [ ] **Step 3: Implement**

Add to `StateDiagnosticOptions`:

```ts
  /**
   * Where the daemon records its last startup outcome. Defaults to this host's log root; tests
   * point it elsewhere. Read only when the daemon does not answer, because that is the only time
   * a person needs to know why.
   */
  daemonStatusPath?: string;
```

Inside `createStateDiagnosticDataSource`, after `socketPathFor`:

```ts
  const recordedStartupFailure = (): DaemonStatus | null => {
    const runtime = options.daemonStatusPath === undefined ? platform().runtime : null;
    const path = options.daemonStatusPath ?? (runtime === null ? null : daemonStatusPath(runtime.paths.logRoot));
    const status = path === null ? null : readDaemonStatus(path);
    return status?.state === 'failed' ? status : null;
  };
```

Replace the unreachable arm of `registrationFinding`'s final `return reachable ? … : …` with a call to this function, defined in the same closure:

```ts
  const unreachableFinding = (): DoctorDiagnostic['findings'][number] => {
    const failure = recordedStartupFailure();
    if (failure === null) {
      return {
        check: 'registration',
        status: 'warning',
        message: 'This worktree is registered, but the daemon is not answering on its socket. '
          + 'Start it with `wtm daemon install`.',
        details: { code: 'WTM_DAEMON_UNAVAILABLE', registered: true, daemonReachable: false },
      };
    }
    const attempts = failure.attempts === 1 ? 'once' : `${String(failure.attempts)} times`;
    const next = failure.remediation === null
      ? 'Run `wtm daemon install` to start it again.'
      : `Run \`${formatRemediation(failure.remediation)}\`, then \`wtm daemon install\` to start it again.`;
    return {
      check: 'registration',
      status: 'error',
      message: [
        `This worktree is registered, but the daemon is not running: it failed to start ${attempts} since ${failure.since}.`,
        (failure.message ?? '').trim(),
        next,
      ].filter((part) => part !== '').join(' '),
      details: {
        code: failure.code ?? 'WTM_DAEMON_UNAVAILABLE',
        registered: true,
        daemonReachable: false,
        startupFailedSince: failure.since,
        startupAttempts: failure.attempts,
        startupPermanent: failure.permanent,
        startupRemediation: failure.remediation === null ? null : formatRemediation(failure.remediation),
      },
    };
  };
```

Import `daemonStatusPath`, `formatRemediation`, `readDaemonStatus` and `type DaemonStatus` from `'./daemon-status'`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `bun test --timeout 60000 packages/cli/src/__tests__/state-diagnostics.test.ts packages/cli/src/__tests__/diagnostics.test.ts`
Expected: PASS. If a doctor schema test in `diagnostics.test.ts` rejects the new `details` keys, the schema at `diagnostics.ts:91` already allows any string-keyed primitive, so fix the test, not the schema.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/state-diagnostics.ts packages/cli/src/__tests__/state-diagnostics.test.ts
git commit -m "feat: doctor reports why an unreachable daemon is down, and names a command that exists (item 45)"
```

---

### Task 7: `wtm daemon install` says when the daemon it installed did not come up

**Files:**
- Modify: `packages/cli/src/commands/daemon.ts` (`runDaemonLifecycleCommand`, `waitUntilReachable`)
- Modify: `packages/cli/src/main.ts:~404` (the lifecycle action's `runDaemonLifecycleCommand` call)
- Test: `packages/cli/src/commands/__tests__/daemon.test.ts`

**Interfaces:**
- Consumes: `DaemonStatus`, `daemonStatusPath`, `readDaemonStatus`, `servicePathsForHost` (Task 4).
- Produces: `runDaemonLifecycleCommand`'s sixth parameter, `readStartupStatus?: () => DaemonStatus | null`. On an install whose daemon recorded a failure *after the install began*, the envelope is `ok: true`, `data.reachable: false`, `data.startup: { state, code, message, since, attempts, permanent, remediation }`, and it carries one warning.

- [ ] **Step 1: Write the failing test**

```ts
  test('an install whose daemon records a startup failure says so at once, instead of waiting out the deadline', async () => {
    let status: DaemonStatus | null = null;
    const manager: ServiceLifecycle = {
      ...fakeManager(),
      install: async () => {
        // The service manager starts the daemon, which fails and records why.
        status = nextDaemonStatus(null, {
          started: false, code: 'WTM_IPC_PATH_UNUSABLE', condition: 'occupied', message: 'The WTM daemon socket path is a directory: /x.',
          remediation: ['wtm', 'doctor'], permanent: true,
        }, new Date(), 9);
        return await fakeManager().install();
      },
    };
    const started = Date.now();
    const envelope = await runDaemonLifecycleCommand(
      'install', manager, async () => false,
      publishedDaemonSocketPath(selectPlatformRuntime({ home: '/Users/x' }).paths.socketRoot),
      undefined, () => status,
    );

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(jsonEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(envelope).toMatchObject({
      ok: true,
      data: { reachable: false, startup: { state: 'failed', code: 'WTM_IPC_PATH_UNUSABLE', permanent: true } },
      warnings: [{ code: 'WTM_IPC_PATH_UNUSABLE', severity: 'warning', remediation: [{ kind: 'command-suggestion', argv: ['wtm', 'doctor'] }] }],
    });
  });

  test('a failure recorded before this install is not blamed on it', async () => {
    const stale = nextDaemonStatus(null, {
      started: false, code: 'WTM_IPC_PATH_UNUSABLE', condition: 'old', message: 'old', remediation: null, permanent: true,
    }, new Date(Date.now() - 60_000), 9);
    const envelope = await runDaemonLifecycleCommand('install', fakeManager(), async () => true, undefined, undefined, () => stale);
    expect(envelope).toMatchObject({ ok: true, data: { reachable: true }, warnings: [] });
  });
```

Import `nextDaemonStatus` and `type DaemonStatus` from `'../../daemon-status'`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test --timeout 60000 packages/cli/src/commands/__tests__/daemon.test.ts -t "install"`
Expected: FAIL. The first test waits the full 20 s deadline, then lacks `startup` and the warning.

- [ ] **Step 3: Implement**

In `runDaemonLifecycleCommand`:
1. Add the parameter, after `platform?: PlatformRuntime,`:

```ts
  /**
   * The daemon's own record of its last startup. After `install` starts the service, a failure
   * recorded since the install began is the reason it is not answering, and waiting out the
   * readiness deadline would only delay saying so (spec decision 4).
   */
  readStartupStatus?: () => DaemonStatus | null,
```

2. Before `const data = published(host, await lifecycle[action]());`, add `const startedAt = Date.now();`.
3. Replace the readiness line and its return with:

```ts
    const freshFailure = (): DaemonStatus | null => {
      const status = readStartupStatus?.() ?? null;
      return status !== null && status.state === 'failed' && Date.parse(status.at) >= startedAt ? status : null;
    };
    const ready = action === 'install'
      ? await waitUntilReachable(reachable, () => freshFailure() !== null)
      : await reachable();
    const failure = action === 'install' && !ready ? freshFailure() : null;
    if (failure === null) return successEnvelope(`daemon ${action}`, { ...data, reachable: ready });
    return {
      ...successEnvelope(`daemon ${action}`, { ...data, reachable: false, startup: startupSummary(failure) }),
      warnings: [startupWarning(failure)],
    };
```

4. Change `waitUntilReachable`:

```ts
async function waitUntilReachable(
  reachable: () => Promise<boolean>,
  startupFailed: () => boolean = () => false,
): Promise<boolean> {
  const deadline = Date.now() + readinessDeadlineMs;
  for (;;) {
    if (await reachable()) return true;
    if (startupFailed() || Date.now() >= deadline) return false;
    await new Promise((settle) => { setTimeout(settle, readinessIntervalMs); });
  }
}
```

5. Add these helpers:

```ts
function startupSummary(status: DaemonStatus) {
  return {
    state: status.state, code: status.code, message: status.message, since: status.since,
    attempts: status.attempts, permanent: status.permanent, remediation: status.remediation,
  };
}

function startupWarning(status: DaemonStatus): WtmError {
  const code = wtmErrorCodeSchema.safeParse(status.code);
  return {
    code: code.success ? code.data : 'WTM_DAEMON_UNAVAILABLE',
    message: `The daemon service was installed, but the daemon did not start: ${status.message ?? 'no reason was recorded.'}`,
    severity: 'warning',
    context: { action: 'install', since: status.since, attempts: status.attempts, permanent: status.permanent },
    ...(status.remediation === null ? {} : { remediation: [{ kind: 'command-suggestion' as const, argv: status.remediation }] }),
  };
}
```

6. Import `type DaemonStatus` from `'../daemon-status'`.

In `main.ts`, change the lifecycle call to:

```ts
        await runDaemonLifecycleCommand(
          action,
          manager,
          () => daemonReachable(defaultDaemonSocketPath()),
          undefined,
          undefined,
          () => {
            const service = servicePathsForHost();
            return service === null ? null : readDaemonStatus(daemonStatusPath(service.logRoot));
          },
        ),
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `bun test --timeout 60000 packages/cli/src/commands/__tests__/daemon.test.ts packages/cli/src/__tests__/daemon-lifecycle.test.ts`
Expected: PASS. The first new test finishes in well under 5 s. `bun run typecheck` must exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/daemon.ts packages/cli/src/main.ts packages/cli/src/commands/__tests__/daemon.test.ts
git commit -m "feat: daemon install reports a daemon that did not start, with its reason (item 45)"
```

---

### Task 8: Close item 45 in `todo.md`, the changelog and the program map; run the full verification

**Files:**
- Modify: `todo.md` (item 45: the heading, seven "Yapılacaklar" boxes, four acceptance boxes, and a dated note; the pre-tag sentence at ~353)
- Modify: `CHANGELOG.md` (`[Unreleased]`)
- Modify: `docs/superpowers/specs/2026-09-09-daemon-startup-crash-loop.md` (Status: `Implemented — 2026-09-XX`)

- [ ] **Step 1: Run the full suite**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: exit 0 and `0 fail`. If `packages/cli/src/__tests__/docs-parity*.test.ts` flags `docs/05` or `docs/18`, fix the doc wording it names; do not weaken the test.

- [ ] **Step 2: Reproduce the field report end to end, by hand, in an isolated HOME**

```bash
export H=$(mktemp -d /tmp/wtm-item45-XXXX)
mkdir -p "$H/Library/Application Support/WTM" && chmod 700 "$H/Library/Application Support/WTM"
: > "$H/Library/Application Support/WTM/.tmd.sock" && chmod 600 "$H/Library/Application Support/WTM/.tmd.sock"
touch -t 202609020000 "$H/Library/Application Support/WTM/.tmd.sock"
HOME=$H WTM_DAEMON_SUPERVISED=1 node --import tsx packages/cli/src/bin.ts daemon serve --json & sleep 3; kill %1
```

Expected: the daemon starts, because the stale placeholder was reclaimed; `.tmd.sock` is gone and `wtmd.sock` is a socket. Then replace the placeholder with a directory (`rm -rf …/.tmd.sock; mkdir …/.tmd.sock`) and run the same command. Expected: exit status 0, an envelope carrying `WTM_IPC_PATH_UNUSABLE`, and `$H/Library/Logs/WTM/daemon-status.json` recording it. On Linux the paths are the XDG ones; derive them with `wtm doctor --json` under the same `HOME`. Record both outputs in the item 45 note.

- [ ] **Step 3: Update `todo.md`, `CHANGELOG.md` and the spec status**

- `todo.md` item 45: change `### [ ] 45.` to `### [x] 45.` and tick every box. Add a `**2026-09-XX:**` note under the heading listing the eight commits, the R1–R5 revisions (with a pointer to the spec section), and the two hand-run results from Step 2.
- `todo.md:~353`: rewrite the pre-tag sentence. 45 is closed, and 36 remains; it waits on the Apple credentials.
- `CHANGELOG.md` `[Unreleased]`: add a `### Fixed` entry. It says that a non-socket file at the daemon's socket path no longer leaves the daemon restarting forever: WTM's own leftover placeholder is reclaimed, and anything else stops the daemon with `WTM_IPC_PATH_UNUSABLE`, which `wtm doctor` and `wtm daemon install` report. It also says that the daemon's own logs are rotated. Under `### Changed`, note that both service definitions now retry every 10 s and set `WTM_DAEMON_SUPERVISED=1`, and that re-running `wtm daemon install` picks the change up.

- [ ] **Step 4: Commit**

```bash
git add todo.md CHANGELOG.md docs/superpowers/specs/2026-09-09-daemon-startup-crash-loop.md
git commit -m "docs: close item 45 with the field reproduction and the spec revisions"
```

---

## Self-review notes

- **Spec coverage.** Decision 1 is covered by Task 2 (with R1). Decision 2 by Task 1. Decision 3 by Task 3 (with R2 and R3). Decision 4 by Tasks 4, 6 and 7 (with R5). Decision 5 by Task 5 (rotation) and Task 4 (frames, R4, and the missing-directory one-liners). Every acceptance criterion maps to a task: the first to Task 2; the second to Tasks 3, 4 and 5; the third to Task 6; the fourth to Task 7.
- **Out of scope, as the spec says.** Windows IPC. Removing the close shield. A `wtm daemon logs` command.
- **Type consistency.** `DaemonStartupOutcome.remediation` and `DaemonStatus.remediation` are `string[] | null` everywhere. `formatRemediation` is the only place an argv becomes text, used by doctor and nothing else, because the install warning keeps the argv.
