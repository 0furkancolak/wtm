import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectPlatformRuntime } from '@wtm/platform';
import type { ObservedProcessIdentity, PlatformId, ProcessInspection } from '@wtm/platform/ports';
import { createLinuxProcessPlatform } from '@wtm/platform/process';
import { developmentRuntimeInvocation } from '../../../testkit/src/runtime-invocation';
import {
  bootTime, groupStats, initStat, parenthesisedCommCmdline, parenthesisedCommComm,
  parenthesisedCommStat, procListing, procStat,
} from '../../../platform/src/process/__tests__/proc-fixtures';
import { ManagedLogStore } from '../logs';
import { ManagedProcessError, ManagedProcessSupervisor } from '../process-supervisor';
import {
  anchorSource, compileAnchorReaders, type AnchorObservedIdentity, type AnchorReaders,
} from '../process-anchor';
import { MemoryManagedProcessStore } from '../../../testkit/src/managed-process-store';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(async () => { await rm(root, { recursive: true, force: true }); });
  return root;
}

function readIdentity(readers: AnchorReaders): Promise<AnchorObservedIdentity> {
  return new Promise((resolve, reject) => {
    readers.readIdentity((error, identity) => {
      if (error !== null) reject(error instanceof Error ? error : new Error(String(error)));
      else if (identity === null) reject(new Error('the reader reported neither an error nor an identity'));
      else resolve(identity);
    });
  });
}

/** Unwraps an inspection the test requires to have found a process, so the comparison is total. */
function presentIdentity(inspection: ProcessInspection): ObservedProcessIdentity {
  if (inspection.status !== 'present') throw new Error(`the port reported ${inspection.status}, not a process`);
  return inspection.identity;
}

function readGroupMembers(readers: AnchorReaders, pgid: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    readers.readGroupMembers(pgid, (error, pids) => {
      if (error !== null) reject(error instanceof Error ? error : new Error(String(error)));
      else if (pids === null) reject(new Error('the reader reported neither an error nor a group'));
      else resolve([...pids].sort((left, right) => left - right));
    });
  });
}

/**
 * Writes captured `/proc` content to a real directory, because the two implementations under test
 * reach the kernel differently — the port through its injected reader, the anchor through
 * `fs.readFileSync` — and only a real filesystem lets one fixture feed both.
 *
 * `files` is keyed by the path under the root, so `'9/stat'` and `'stat'` are the process entry and
 * the system entry the two readers each look for.
 */
async function fixtureProc(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await scratch('wtm-anchor-proc-');
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

/**
 * The captured `stat` lines name the PIDs of the container they were read from. The anchor reads
 * *itself* — it has no other process to ask about — so the PID at the head of the line is rewritten
 * to this process's, and nothing else about the line is touched: the hostile `comm`, the field
 * count and the tick counts are the kernel's own.
 */
function asSelf(statLine: string): string {
  return statLine.replace(/^\d+ /, `${String(process.pid)} `);
}

/**
 * D2. The anchor is a source string compiled with `Function('require', ...)` inside the spawned
 * child: it has no module graph, so it cannot import `@wtm/platform` and has to carry its own copy
 * of both readers. A duplicate is only safe while something goes red when the two halves disagree,
 * and this is that something — `compileAnchorReaders` compiles the exact text the child runs, and
 * every test below runs it beside the port over one process or one set of files and demands
 * byte-identical output.
 */
describe('the anchor reads a process exactly as the platform port reads it', () => {
  const runtime = selectPlatformRuntime();

  test('agrees with the selected platform about this live process', async () => {
    const identity = await readIdentity(compileAnchorReaders({ platform: runtime.id }));
    const inspection = await runtime.process.inspectProcess(process.pid);

    expect(inspection.status).toBe('present');
    expect(identity).toEqual(presentIdentity(inspection));
  });

  test('agrees with the selected platform about who is in this live process group', async () => {
    const readers = compileAnchorReaders({ platform: runtime.id });
    const identity = await readIdentity(readers);
    const members = await readGroupMembers(readers, identity.pgid);
    const inspection = await runtime.process.inspectProcessGroup(identity.pgid);

    // Exact set equality would be a race, not an assertion: both readers scan the whole process
    // table and a group this test does not own gains and loses members between the two scans.
    // Membership of the one process that certainly cannot vanish is what is decidable here.
    expect(members).toContain(process.pid);
    expect(inspection.status === 'present' ? [...inspection.pids] : []).toContain(process.pid);
  });

  /**
   * The Linux half, on whichever host runs this. These are the same captured kernel lines the
   * port's own tests parse, so a `comm` containing spaces and unbalanced parentheses — the field
   * that desynchronises every naive `/proc` parser — is covered on both sides at once.
   */
  test('reads a captured /proc identity the way the Linux port reads it', async () => {
    const procRoot = await fixtureProc({
      stat: procStat,
      [`${String(process.pid)}/stat`]: asSelf(initStat),
      [`${String(process.pid)}/comm`]: 'bash\n',
      [`${String(process.pid)}/cmdline`]: '/bin/bash\0-l\0',
    });

    const identity = await readIdentity(compileAnchorReaders({ platform: 'linux', procRoot }));
    const inspection = await createLinuxProcessPlatform({ procRoot }).inspectProcess(process.pid);

    expect(inspection.status).toBe('present');
    expect(identity).toEqual(presentIdentity(inspection));
    // Named as well as compared, because "the two agree" would still hold if both were wrong. This
    // is the boot time and the start-time ticks the kernel actually printed.
    expect(identity.processStartTime).toBe(`${bootTime}:2807658`);
  });

  test('ends a captured comm at the last parenthesis, the way the Linux port does', async () => {
    const procRoot = await fixtureProc({
      stat: procStat,
      [`${String(process.pid)}/stat`]: asSelf(parenthesisedCommStat),
      [`${String(process.pid)}/comm`]: parenthesisedCommComm,
      [`${String(process.pid)}/cmdline`]: parenthesisedCommCmdline,
    });

    const identity = await readIdentity(compileAnchorReaders({ platform: 'linux', procRoot }));
    const inspection = await createLinuxProcessPlatform({ procRoot }).inspectProcess(process.pid);

    expect(inspection.status).toBe('present');
    expect(identity).toEqual(presentIdentity(inspection));
    expect(identity.processStartTime).toBe(`${bootTime}:2778072`);
  });

  test('walks a captured /proc for group members the way the Linux port does', async () => {
    const procRoot = await groupFixture();

    const members = await readGroupMembers(compileAnchorReaders({ platform: 'linux', procRoot }), 6);
    const inspection = await createLinuxProcessPlatform({ procRoot }).inspectProcessGroup(6);

    expect(members).toEqual([6, 8, 9, 10]);
    expect(inspection.status === 'present' ? [...inspection.pids].sort((a, b) => a - b) : []).toEqual(members);
  });

  /**
   * D6, from the anchor's side. The group it drains is a group it forked, so every real member is
   * same-uid and readable; an entry it may not read belongs to somebody else. Failing the whole
   * scan on one such entry — under `hidepid`, in a container, on a shared host — would leave the
   * poll retrying every 25 ms forever and the anchor would never exit, which is a leaked process
   * tree rather than a wrong number.
   */
  test('treats a /proc entry it may not read as not a member, rather than failing the scan', async () => {
    if (process.getuid?.() === 0) throw new Error('this test needs a uid that permissions apply to');
    const procRoot = await groupFixture();
    const foreign = join(procRoot, '13', 'stat');
    await mkdir(join(procRoot, '13'), { recursive: true });
    await writeFile(foreign, '13 (secret) S 1 6 6 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 2807663 0\n');
    await chmod(foreign, 0o000);

    expect(await readGroupMembers(compileAnchorReaders({ platform: 'linux', procRoot }), 6))
      .toEqual([6, 8, 9, 10]);
  });
});

/**
 * D1. The dialect the anchor speaks is a property of the decision the supervisor already made, not
 * of the machine the anchor woke up on. If the anchor observed its own platform the two could
 * disagree, and the disagreement would reach the user as `ANCHOR_IDENTITY_MISMATCH` — a message
 * accusing the process of changing identity when the two sides were merely speaking different
 * dialects. Being told is the only construction in which that cannot happen.
 */
describe('the anchor is told which identity dialect to speak', () => {
  test('never asks the machine what platform it is', () => {
    // A source assertion because the rule is about what the text may reference: on the host where
    // the told platform and the observed one agree, no runtime observation can tell them apart.
    expect(anchorSource).not.toContain('process.platform');
  });

  test('speaks the dialect it was told even when the host cannot produce it', async () => {
    const procRoot = await fixtureProc({
      stat: procStat,
      [`${String(process.pid)}/stat`]: asSelf(initStat),
      [`${String(process.pid)}/comm`]: 'bash\n',
      [`${String(process.pid)}/cmdline`]: '/bin/bash\0-l\0',
    });

    const identity = await readIdentity(compileAnchorReaders({ platform: 'linux', procRoot }));

    // `<btime>:<ticks>`, which is the Linux spelling and cannot be produced by reading a macOS
    // process. On a macOS host this is the whole proof; on a Linux host it is the port's format
    // read from a `/proc` that is not the host's.
    expect(identity.processStartTime).toMatch(/^\d+:\d+$/);
  });

  test('refuses to guess when it is told nothing', async () => {
    await expect(readIdentity(compileAnchorReaders({ platform: '' })))
      .rejects.toThrow('ANCHOR_PLATFORM_UNKNOWN');
  });
});

/**
 * The other half of D1: the supervisor has to actually say it. `WTM_ANCHOR_SPEC` is the only
 * channel, so these tests read what a spawned child was handed rather than what the supervisor
 * meant to hand it.
 */
describe('the supervisor tells the anchor the platform it selected', () => {
  test('names its own selection when nothing is injected', async () => {
    expect((await captureAnchorSpec()).platform).toBe(selectPlatformRuntime().id);
  });

  test('names an injected platform, so a daemon built for one platform cannot spawn an anchor speaking another', async () => {
    expect((await captureAnchorSpec('linux')).platform).toBe('linux');
    expect((await captureAnchorSpec('darwin')).platform).toBe('darwin');
  });
});

/**
 * Spawns a stand-in for the anchor that records the spec it was handed and exits. The start then
 * fails — there is no handshake — which is why the failure is asserted rather than avoided: what is
 * under test is what the child was told, and a start that succeeded would prove less.
 */
async function captureAnchorSpec(platform?: PlatformId): Promise<Record<string, unknown>> {
  const root = await scratch('wtm-anchor-spec-');
  const specPath = join(root, 'spec.json');
  const supervisor = new ManagedProcessSupervisor({
    stateStore: new MemoryManagedProcessStore(),
    logs: new ManagedLogStore({ root: join(root, 'logs') }),
    gracePeriodMs: 100,
    pollIntervalMs: 10,
    runtimeInvocation: {
      executable: '/bin/sh',
      prefixArgs: ['-c', `printf '%s' "$WTM_ANCHOR_SPEC" > '${specPath}'; exit 1`],
    },
    ...(platform === undefined ? {} : { platform }),
  });
  cleanups.push(async () => { await supervisor.close(); });

  let failure: unknown;
  try {
    await supervisor.start({
      worktreeId: 'worktree-1', taskName: 'spec', argv: ['/bin/true'], cwd: root, env: process.env,
    });
  } catch (error) { failure = error; }

  expect((failure as ManagedProcessError | undefined)?.code).toBe('RUNTIME_START_FAILED');
  return JSON.parse(await readFile(specPath, 'utf8')) as Record<string, unknown>;
}

/** The captured container: `bash` at PID 6 leading group 6, three `sleep` children, PID 1 elsewhere. */
async function groupFixture(): Promise<string> {
  const files: Record<string, string> = { stat: procStat };
  for (const [pid, line] of Object.entries(groupStats)) files[`${pid}/stat`] = line;
  // The listing's non-process entries and its two PIDs that exited before their `stat` could be
  // read are both in the fixture on purpose: the first is what a `/^\d+$/` filter is for, the
  // second is the ordinary case of a process leaving during the walk.
  for (const entry of procListing) {
    if (/^\d+$/.test(entry) && files[`${entry}/stat`] === undefined) files[`${entry}/.keep`] = '';
    if (!/^\d+$/.test(entry) && entry !== 'stat') files[entry] = 'not a process\n';
  }
  return await fixtureProc(files);
}

describe('process anchor runtime invocation', () => {
  test('starts and stops through the injected executable without resolving a runtime from PATH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wtm-anchor-runtime-'));
    const commands = join(root, 'commands');
    await mkdir(commands);
    await symlink('/bin/ps', join(commands, 'ps'));
    const task = join(commands, 'fixture-task');
    await writeFile(task, '#!/bin/sh\nexec /bin/sleep 30\n');
    await chmod(task, 0o700);
    const store = new MemoryManagedProcessStore();
    const supervisor = new ManagedProcessSupervisor({
      stateStore: store,
      logs: new ManagedLogStore({ root: join(root, 'logs') }),
      pollIntervalMs: 10,
      runtimeInvocation: developmentRuntimeInvocation(),
    });
    cleanups.push(async () => {
      await supervisor.close();
      await rm(root, { recursive: true, force: true });
    });

    const started = await supervisor.start({
      worktreeId: 'worktree-1',
      taskName: 'fixture',
      argv: ['fixture-task'],
      cwd: root,
      env: { PATH: commands },
    });

    expect(started.record.state).toBe('RUNNING');
    expect((await supervisor.stop({ worktreeId: 'worktree-1', taskName: 'fixture' })).state).toBe('STOPPED');
  });
});
