import { expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile, rename, link, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import type { WindowsAclBatch, WindowsAclBatchReader, WindowsPathAcl } from '@wtm/platform/trust';
import { createAnchorLogStore } from '../anchor-log-trust';

const currentSid = 'S-1-5-21-42';
const privateAcl: WindowsPathAcl = { ownerSid: currentSid,
  accessRules: [{ identitySid: currentSid, accessControlType: 'Allow', fileSystemRights: 'FullControl' }] };
function evidence(paths: readonly string[]): WindowsAclBatch {
  return { currentSid, acls: new Map(paths.map((path) => [path, privateAcl])) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => setImmediate(resolve)); }
async function write(stream: Writable, value: string): Promise<void> {
  await new Promise<void>((resolve, reject) => stream.write(value, (error) => error ? reject(error) : resolve()));
}
async function fixture(readAclBatch: WindowsAclBatchReader = async (paths) => evidence(paths),
  options: { platform?: string; retainedFiles?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'wtm-anchor-log-trust-'));
  await chmod(root, 0o700);
  const directory = join(root, 'task'); await mkdir(directory, { mode: 0o700 });
  const spec = { root, stdoutPath: join(directory, 'stdout.log'), stderrPath: join(directory, 'stderr.log'),
    launchMarkerPath: join(directory, 'launch.json'), completionMarkerPath: join(directory, 'completion.json'),
    rotationBytes: 4, retainedFiles: options.retainedFiles ?? 3 };
  await writeFile(spec.stdoutPath, '', { mode: 0o600 }); await writeFile(spec.stderrPath, '', { mode: 0o600 });
  const store = createAnchorLogStore(options.platform ?? 'win32', spec, { readAclBatch });
  return { root, directory, spec, store, async close() { await store.close(); await rm(root, { recursive: true, force: true }); } };
}

test('Windows log authorization checks each new empty file and ignores synthetic POSIX permission bits', async () => {
  let calls = 0;
  const run = await fixture(async (paths) => {
    calls++;
    for (const path of paths) if (path.endsWith('.tmp')) expect(fs.statSync(path).size).toBe(0);
    return evidence(paths);
  });
  try {
    await chmod(run.root, 0o777); await chmod(run.directory, 0o777); await chmod(run.spec.stdoutPath, 0o666);
    const streams = await run.store.open();
    await write(streams.stdout, 'ab'); await write(streams.stdout, 'cd');
    expect(calls).toBe(1); // Ordinary chunks use the verified fd; no PowerShell per chunk.
    expect(await readFile(run.spec.stdoutPath, 'utf8')).toBe('abcd');
  } finally { await run.close(); }
});

test('unsafe permissions on a newly created temporary refuse all trusted marker and log bytes', async () => {
  const run = await fixture(async (paths) => {
    const acls = new Map(evidence(paths).acls);
    const temporary = paths.find((path) => path.endsWith('.tmp'))!;
    acls.set(temporary, { ownerSid: currentSid, accessRules: [
      { identitySid: 'S-1-1-0', accessControlType: 'Allow', fileSystemRights: 'Read' },
    ] });
    return { currentSid, acls };
  });
  try {
    await expect(run.store.open()).rejects.toThrow('UNSAFE_LOG_ACL');
    expect(await readFile(run.spec.stdoutPath, 'utf8')).toBe('');
    expect(fs.existsSync(`${run.spec.stdoutPath}.generation`)).toBe(false);
  } finally { await run.close(); }
});

test('a parent swap while ACL authorization waits cannot publish into the replacement directory', async () => {
  const allowed = deferred<WindowsAclBatch>(); let requested: readonly string[] = [];
  const run = await fixture(async (paths) => { requested = paths; return await allowed.promise; });
  try {
    const opened = run.store.open(); await flush(); expect(requested.length).toBeGreaterThan(0);
    await rename(run.directory, `${run.directory}-original`); await mkdir(run.directory, { mode: 0o700 });
    await writeFile(run.spec.stdoutPath, 'external', { mode: 0o600 });
    allowed.resolve(evidence(requested));
    await expect(opened).rejects.toThrow('LOG_DIRECTORY_CHANGED');
    expect(await readFile(run.spec.stdoutPath, 'utf8')).toBe('external');
    expect(fs.existsSync(`${run.spec.stdoutPath}.generation`)).toBe(false);
  } finally { allowed.resolve(evidence(requested)); await run.close(); }
});

test('a hard link introduced while ACL authorization waits is refused before writing', async () => {
  const allowed = deferred<WindowsAclBatch>(); let requested: readonly string[] = [];
  const run = await fixture(async (paths) => { requested = paths; return await allowed.promise; });
  try {
    const opened = run.store.open(); await flush();
    await link(run.spec.stdoutPath, join(run.root, 'external-link'));
    allowed.resolve(evidence(requested)); await expect(opened).rejects.toThrow('UNSAFE_LOG_TARGET');
    expect(await readFile(run.spec.stdoutPath, 'utf8')).toBe('');
  } finally { allowed.resolve(evidence(requested)); await run.close(); }
});

test('rotation backpressure serializes buffered writes behind one fresh ACL batch', async () => {
  let calls = 0; let requested: readonly string[] = [];
  const allowed = deferred<WindowsAclBatch>();
  const run = await fixture(async (paths) => {
    calls++; requested = paths; return calls === 2 ? await allowed.promise : evidence(paths);
  });
  try {
    const streams = await run.store.open(); await write(streams.stdout, 'abcd');
    const completed: string[] = [];
    const first = write(streams.stdout, 'ef').then(() => { completed.push('ef'); });
    const next = write(streams.stdout, 'gh').then(() => { completed.push('gh'); });
    await flush(); expect(calls).toBe(2); expect(completed).toEqual([]);
    expect(await readFile(run.spec.stdoutPath, 'utf8')).toBe('abcd');
    allowed.resolve(evidence(requested)); await Promise.all([first, next]);
    expect(completed).toEqual(['ef', 'gh']); expect(calls).toBe(2);
    expect(await readFile(`${run.spec.stdoutPath}.1`, 'utf8')).toBe('abcd');
    expect(await readFile(run.spec.stdoutPath, 'utf8')).toBe('efgh');
  } finally { allowed.resolve(evidence(requested)); await run.close(); }
});

test('aborted rotation discards a late ACL result without archiving or writing the buffered chunk', async () => {
  let calls = 0; let requested: readonly string[] = [];
  const allowed = deferred<WindowsAclBatch>(); const controller = new AbortController();
  const run = await fixture(async (paths) => {
    calls++; requested = paths; return calls === 2 ? await allowed.promise : evidence(paths);
  });
  try {
    const streams = await run.store.open(controller.signal); streams.stdout.on('error', () => {});
    await write(streams.stdout, 'abcd');
    const writing = write(streams.stdout, 'ef'); await flush();
    controller.abort(); allowed.resolve(evidence(requested));
    await expect(writing).rejects.toThrow('ANCHOR_LOG_OPERATION_ABORTED');
    expect(await readFile(run.spec.stdoutPath, 'utf8')).toBe('abcd');
    expect(fs.existsSync(`${run.spec.stdoutPath}.1`)).toBe(false);
  } finally { allowed.resolve(evidence(requested)); await run.close(); }
});

test('completion reads fresh ACLs and evaluates result only after authorization', async () => {
  let calls = 0; let requested: readonly string[] = [];
  const allowed = deferred<WindowsAclBatch>(); let timedOut = false;
  const run = await fixture(async (paths) => {
    calls++; requested = paths; return calls === 2 ? await allowed.promise : evidence(paths);
  });
  try {
    await run.store.open();
    const completed = run.store.publishCompletion(() => ({ timedOut, exitCode: timedOut ? null : 0 }));
    await flush(); expect(calls).toBe(2); expect(fs.existsSync(run.spec.completionMarkerPath)).toBe(false);
    timedOut = true; allowed.resolve(evidence(requested)); await completed;
    expect(JSON.parse(await readFile(run.spec.completionMarkerPath, 'utf8'))).toEqual({ timedOut: true, exitCode: null });
  } finally { allowed.resolve(evidence(requested)); await run.close(); }
});

for (const stage of ['first-temporary-stat', 'current-transfer-stat'] as const) {
  test(`an fstat failure at ${stage} closes the descriptor whose ownership was not transferred`, async () => {
    const run = await fixture();
    const original = fs.fstatSync; let failedFd: number | undefined; let seenCurrent = 0;
    if (stage === 'current-transfer-stat') await rm(run.spec.stdoutPath);
    const patched = spyOn(fs, 'fstatSync').mockImplementation(((fd: number) => {
      const stat = original(fd);
      if (failedFd === undefined) {
        let current = false;
        try { const value = fs.lstatSync(run.spec.stdoutPath); current = stat.ino === value.ino && stat.dev === value.dev; } catch { /* Not published yet. */ }
        if (current) seenCurrent++;
        if (stage === 'first-temporary-stat' || current && seenCurrent === 2) {
          failedFd = fd; throw new Error('INJECTED_FSTAT_FAILURE');
        }
      }
      return stat;
    }) as typeof fs.fstatSync);
    try {
      await expect(run.store.open()).rejects.toThrow('INJECTED_FSTAT_FAILURE');
      expect(failedFd).toBeDefined();
      expect(() => original(failedFd!)).toThrow();
    } finally {
      patched.mockRestore();
      if (failedFd !== undefined) { try { fs.closeSync(failedFd); } catch { /* Correctly closed by the operation. */ } }
      await run.close();
    }
  });
}

test('the maximum 32 retained files fits the real startup operation path budget', async () => {
  let inspected = 0;
  const run = await fixture(async (paths) => { inspected = paths.length; return evidence(paths); }, { retainedFiles: 32 });
  try {
    for (const target of [run.spec.stdoutPath, run.spec.stderrPath]) {
      for (let suffix = 1; suffix <= 32; suffix++) await writeFile(`${target}.${suffix}`, String(suffix), { mode: 0o600 });
    }
    const streams = await run.store.open();
    expect(inspected).toBeGreaterThan(64); expect(inspected).toBeLessThanOrEqual(128);
    await write(streams.stdout, 'next');
    expect(await readFile(run.spec.stdoutPath, 'utf8')).toBe('next');
    expect(await readFile(`${run.spec.stdoutPath}.32`, 'utf8')).toBe('32');
  } finally { await run.close(); }
});

// These are the existing supervisor crash fixtures, run directly through the shipped writer so
// process-table visibility cannot hide rotation regressions. On POSIX hosts they use real mode
// checks; on Windows they use captured ACL decisions, not a claim about native Get-Acl behavior.
for (const scenario of [
  { name: 'marker', phase: 'marker', shifts: 0, archived: false, opened: false },
  { name: 'closed', phase: 'closed', shifts: 0, archived: false, opened: false },
  { name: 'oldest-only', phase: 'closed', shifts: 1, archived: false, opened: false },
  { name: 'oldest-and-newest', phase: 'closed', shifts: 2, archived: false, opened: false },
  { name: 'shifted', phase: 'shifted', shifts: 2, archived: false, opened: false },
  { name: 'shifted-current-absent', phase: 'shifted', shifts: 2, archived: true, opened: false },
  { name: 'archived', phase: 'archived', shifts: 2, archived: true, opened: false },
  { name: 'opened', phase: 'opened', shifts: 2, archived: true, opened: true },
] as const) {
  test(`the actual log writer recovers partial retained-generation shift ${scenario.name} idempotently`, async () => {
    const platform = process.platform === 'win32' ? 'win32' : 'linux';
    const run = await fixture(undefined, { platform });
    try {
      await writeFile(run.spec.stdoutPath, 'B2--');
      await writeFile(`${run.spec.stdoutPath}.1`, 'B1--', { mode: 0o600 });
      await writeFile(`${run.spec.stdoutPath}.2`, 'B0--', { mode: 0o600 });
      if (scenario.shifts >= 1) await rename(`${run.spec.stdoutPath}.2`, `${run.spec.stdoutPath}.3`);
      if (scenario.shifts >= 2) await rename(`${run.spec.stdoutPath}.1`, `${run.spec.stdoutPath}.2`);
      if (scenario.archived) await rename(run.spec.stdoutPath, `${run.spec.stdoutPath}.1`);
      if (scenario.opened) await writeFile(run.spec.stdoutPath, '', { mode: 0o600 });
      await writeFile(`${run.spec.stdoutPath}.generation`, `rotating-2-${scenario.phase}-4242`, { mode: 0o600 });
      const streams = await run.store.open(); await write(streams.stdout, 'B3--');
      expect(await readFile(`${run.spec.stdoutPath}.generation`, 'utf8')).toBe('3');
      const targets = [run.spec.stdoutPath, `${run.spec.stdoutPath}.1`, `${run.spec.stdoutPath}.2`, `${run.spec.stdoutPath}.3`];
      const before = await Promise.all(targets.map((target) => readFile(target, 'utf8')));
      expect(before).toEqual(['B3--', 'B2--', 'B1--', 'B0--']);
      await run.store.close();
      await writeFile(`${run.spec.stdoutPath}.generation`, 'rotating-2-opened-repeat', { mode: 0o600 });
      const repeated = createAnchorLogStore(platform, run.spec, { readAclBatch: async (paths) => evidence(paths) });
      try {
        await repeated.open();
        expect(await Promise.all(targets.map((target) => readFile(target, 'utf8')))).toEqual(before);
        expect(await readFile(`${run.spec.stdoutPath}.generation`, 'utf8')).toBe('3');
      } finally { await repeated.close(); }
    } finally { await run.close(); }
  });
}

for (const scenario of [
  { name: 'invalid marker', marker: 'not-a-generation', retained: true },
  { name: 'closed marker with missing current', marker: 'rotating-2-closed-4242', retained: true },
  { name: 'shifted marker without an archive', marker: 'rotating-2-shifted-4242', retained: false },
]) {
  test(`the actual log writer fails closed for ${scenario.name}`, async () => {
    const run = await fixture(undefined, { platform: process.platform === 'win32' ? 'win32' : 'linux' });
    try {
      await writeFile(run.spec.stdoutPath, 'B2--');
      if (scenario.retained) await rename(run.spec.stdoutPath, `${run.spec.stdoutPath}.1`);
      else await rm(run.spec.stdoutPath);
      await writeFile(`${run.spec.stdoutPath}.generation`, scenario.marker, { mode: 0o600 });
      await expect(run.store.open()).rejects.toThrow();
      if (scenario.retained) expect(await readFile(`${run.spec.stdoutPath}.1`, 'utf8')).toBe('B2--');
      else expect(fs.existsSync(`${run.spec.stdoutPath}.1`)).toBe(false);
    } finally { await run.close(); }
  });
}
