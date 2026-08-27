import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdtemp, open, readFile, rename, rm, symlink, link, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagedLogStore } from '../logs';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'wtm-logs-'));
  roots.push(value);
  return value;
}

describe('ManagedLogStore', () => {
  test('redirects output to user-only files below the injected log root', async () => {
    const logRoot = await root();
    const logs = new ManagedLogStore({ root: logRoot, rotationBytes: 1024, retainedFiles: 3 });
    const opened = await logs.open('worktree-1', 'dev');
    await opened.stdout.write('out\n');
    await opened.stderr.write('err\n');
    await opened.close();

    expect(await readFile(opened.stdoutPath, 'utf8')).toBe('out\n');
    expect(await readFile(opened.stderrPath, 'utf8')).toBe('err\n');
    expect((await lstat(opened.stdoutPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(opened.stderrPath)).mode & 0o777).toBe(0o600);
    expect(opened.stdoutPath.startsWith(`${logRoot}/`)).toBe(true);
  });

  test('rotates at the configured bound and retains only the configured generations', async () => {
    const logRoot = await root();
    const logs = new ManagedLogStore({ root: logRoot, rotationBytes: 8, retainedFiles: 3 });
    const first = await logs.open('worktree-1', 'dev');
    await first.stdout.write('12345678');
    await first.close();

    for (const value of ['abcdefgh', 'ABCDEFGH', '87654321', 'last']) {
      const opened = await logs.open('worktree-1', 'dev');
      await opened.stdout.write(value);
      await opened.close();
    }

    expect(await readFile(first.stdoutPath, 'utf8')).toBe('last');
    expect(await readFile(`${first.stdoutPath}.1`, 'utf8')).toBe('87654321');
    expect(await readFile(`${first.stdoutPath}.2`, 'utf8')).toBe('ABCDEFGH');
    expect(await readFile(`${first.stdoutPath}.3`, 'utf8')).toBe('abcdefgh');
    expect(await lstat(`${first.stdoutPath}.4`).then(() => true, () => false)).toBe(false);
  });

  test('rejects traversal identifiers plus symlink and hardlink log targets', async () => {
    const logRoot = await root();
    const logs = new ManagedLogStore({ root: logRoot });
    await expect(logs.open('../outside', 'dev')).rejects.toThrow('Unsafe managed log identifier');

    const initial = await logs.open('worktree-1', 'dev');
    const stdoutPath = initial.stdoutPath;
    await initial.close();
    await rm(stdoutPath);
    await symlink('/dev/null', stdoutPath);
    await expect(logs.open('worktree-1', 'dev')).rejects.toThrow('Unsafe managed log target');

    await rm(stdoutPath);
    const other = join(logRoot, 'other.log');
    await writeFile(other, 'shared', { mode: 0o600 });
    await link(other, stdoutPath);
    await expect(logs.open('worktree-1', 'dev')).rejects.toThrow('Unsafe managed log target');
  });

  test('reads a deterministic bounded tail without buffering the full log contractually', async () => {
    const logRoot = await root();
    const logs = new ManagedLogStore({ root: logRoot });
    const opened = await logs.open('worktree-1', 'dev');
    await opened.stdout.write('0123456789');
    await opened.close();

    expect(await logs.read(opened.stdoutPath, 4)).toBe('6789');
    await expect(logs.read(join(logRoot, '..', 'secret'), 4)).rejects.toThrow('outside managed log root');
  });

  test('never copy-truncates an active writer because rotation belongs to the anchor', async () => {
    const logRoot = await root();
    const logs = new ManagedLogStore({ root: logRoot, rotationBytes: 8, retainedFiles: 3 });
    const opened = await logs.open('worktree-1', 'active');
    await opened.stdout.write('12345678');

    await opened.maintain();
    await opened.stdout.write('next');
    await opened.close();

    expect(await readFile(opened.stdoutPath, 'utf8')).toBe('12345678next');
    expect(await lstat(`${opened.stdoutPath}.1`).then(() => true, () => false)).toBe(false);
  });

  test('reads each byte after a generation cursor once across close-and-rename rotation', async () => {
    const logRoot = await root();
    const logs = new ManagedLogStore({ root: logRoot, rotationBytes: 6, retainedFiles: 3 });
    const opened = await logs.open('worktree-1', 'cursor');
    await opened.stdout.write('aaaa');
    const first = await logs.readCursor(opened.stdoutPath);
    await opened.stdout.write('aa');
    const second = await logs.readCursor(opened.stdoutPath, first.cursor);
    await opened.close();
    await rename(opened.stdoutPath, `${opened.stdoutPath}.1`);
    await writeFile(opened.stdoutPath, 'bbbbbbbb', { mode: 0o600 });
    await writeFile(`${opened.stdoutPath}.generation`, '1', { mode: 0o600 });
    const third = await logs.readCursor(opened.stdoutPath, second.cursor);

    expect([first.content, second.content, third.content]).toEqual(['aaaa', 'aa', 'bbbbbbbb']);
    expect(first.cursor.rotated).toBe(false);
    expect(second.cursor.rotated).toBe(false);
    expect(third.cursor.rotated).toBe(true);
  });

  test('advances a cursor by only the bytes returned under its exact bound', async () => {
    const logRoot = await root();
    const logs = new ManagedLogStore({ root: logRoot });
    const opened = await logs.open('worktree-1', 'bounded-cursor');
    await opened.stdout.write('abcdef');
    const first = await logs.readCursor(opened.stdoutPath, undefined, 3);
    await opened.stdout.write('ghij');
    const second = await logs.readCursor(opened.stdoutPath, first.cursor, 2);
    const third = await logs.readCursor(opened.stdoutPath, second.cursor, 2);
    await opened.close();

    expect([first.content, second.content, third.content]).toEqual(['def', 'gh', 'ij']);
    expect([first.cursor.offset, second.cursor.offset, third.cursor.offset]).toEqual([6, 8, 10]);
  });

  test('does not advance past an un-emitted partial UTF-8 code point', async () => {
    const logRoot = await root();
    const logs = new ManagedLogStore({ root: logRoot });
    const opened = await logs.open('worktree-1', 'utf8-cursor');
    await opened.stdout.write('A');
    const initial = await logs.readCursor(opened.stdoutPath);
    await opened.stdout.write('🧪🧪');
    const first = await logs.readCursor(opened.stdoutPath, initial.cursor, 5);
    const second = await logs.readCursor(opened.stdoutPath, first.cursor, 4);
    await opened.close();

    expect([first.content, second.content]).toEqual(['🧪', '🧪']);
    expect([first.cursor.offset, second.cursor.offset]).toEqual([5, 9]);
  });

  test('retries a cursor read across a concurrent generation publication without duplicates', async () => {
    const logRoot = await root();
    const initial = new ManagedLogStore({ root: logRoot });
    const opened = await initial.open('worktree-1', 'cursor-race');
    await opened.stdout.write('aaaa');
    const first = await initial.readCursor(opened.stdoutPath);
    await opened.stdout.write('bb');
    await opened.close();
    let rotated = false;
    const logs = new ManagedLogStore({
      root: logRoot,
      raceHook: async (phase, path) => {
        if (phase !== 'during-cursor-read' || rotated || path !== opened.stdoutPath) return;
        rotated = true;
        await rename(path, `${path}.1`);
        await writeFile(path, 'cc', { mode: 0o600 });
        await writeFile(`${path}.generation`, '1', { mode: 0o600 });
      },
    });

    const second = await logs.readCursor(opened.stdoutPath, first.cursor, 16);
    const third = await logs.readCursor(opened.stdoutPath, second.cursor, 16);

    expect(second.content).toBe('bbcc');
    expect(third.content).toBe('');
    expect(second.cursor.rotated).toBe(true);
  });

  test('retries when rotation archives current after the marker sample but before segment open', async () => {
    const logRoot = await root();
    const initial = new ManagedLogStore({ root: logRoot });
    const opened = await initial.open('worktree-1', 'pre-open-race');
    await opened.stdout.write('abc');
    const cursor = (await initial.readCursor(opened.stdoutPath)).cursor;
    await opened.stdout.write('d');
    await opened.close();
    let rotated = false;
    const logs = new ManagedLogStore({
      root: logRoot,
      raceHook: async (phase, path) => {
        if (phase !== 'after-generation-read' || rotated || path !== opened.stdoutPath) return;
        rotated = true;
        await writeFile(`${path}.generation`, 'rotating-0-shifted-4242', { mode: 0o600 });
        await rename(path, `${path}.1`);
        await writeFile(path, 'new', { mode: 0o600 });
        await writeFile(`${path}.generation`, '1', { mode: 0o600 });
      },
    });

    const read = await logs.readCursor(opened.stdoutPath, cursor, 16);
    expect(read.content).toBe('dnew');
    expect((await logs.readCursor(opened.stdoutPath, read.cursor, 16)).content).toBe('');
  });

  test('resolves a crash between current rename and the next phase publication', async () => {
    const logRoot = await root();
    const initial = new ManagedLogStore({ root: logRoot });
    const opened = await initial.open('worktree-1', 'rename-crash');
    await opened.stdout.write('old!');
    const cursor = (await initial.readCursor(opened.stdoutPath)).cursor;
    await opened.close();
    await writeFile(`${opened.stdoutPath}.generation`, 'rotating-0-shifted-4242', { mode: 0o600 });
    let renamed = false;
    const logs = new ManagedLogStore({
      root: logRoot,
      raceHook: async (phase, path) => {
        if (phase !== 'before-cursor-segment-open' || renamed) return;
        renamed = true;
        await rename(path, `${path}.1`);
      },
    });

    const recovered = await logs.readCursor(opened.stdoutPath, cursor, 16);
    expect(renamed).toBe(true);
    expect(recovered.content).toBe('');
    expect(recovered.cursor.generation).toBe('0');
  });

  test('reads crash-left rotation phases without skipping or duplicating cursor bytes', async () => {
    for (const phase of ['marker', 'closed', 'shifted', 'archived', 'opened'] as const) {
      const logRoot = await root();
      const logs = new ManagedLogStore({ root: logRoot, rotationBytes: 4, retainedFiles: 3 });
      const opened = await logs.open('worktree-1', `phase-${phase}`);
      await opened.stdout.write('old!');
      const cursor = (await logs.readCursor(opened.stdoutPath)).cursor;
      await opened.close();
      await writeFile(`${opened.stdoutPath}.generation`, `rotating-0-${phase}-4242`, { mode: 0o600 });
      if (phase === 'archived' || phase === 'opened') await rename(opened.stdoutPath, `${opened.stdoutPath}.1`);
      if (phase === 'opened') await writeFile(opened.stdoutPath, '', { mode: 0o600 });

      const during = await logs.readCursor(opened.stdoutPath, cursor);
      expect(during.content).toBe('');
      expect(during.cursor.generation).toBe('0');

      if (phase !== 'archived' && phase !== 'opened') await rename(opened.stdoutPath, `${opened.stdoutPath}.1`);
      if (phase !== 'opened') await writeFile(opened.stdoutPath, '', { mode: 0o600 });
      await writeFile(opened.stdoutPath, 'new!', { flag: 'a' });
      await writeFile(`${opened.stdoutPath}.generation`, '1', { mode: 0o600 });
      const after = await logs.readCursor(opened.stdoutPath, during.cursor);
      const repeated = await logs.readCursor(opened.stdoutPath, after.cursor);

      expect(after.content).toBe('new!');
      expect(repeated.content).toBe('');
      expect(await lstat(`${opened.stdoutPath}.4`).then(() => true, () => false)).toBe(false);
    }
  });

  test('tracks an older cursor inode while retained generations are partially shifted', async () => {
    const logRoot = await root();
    const logs = new ManagedLogStore({ root: logRoot, rotationBytes: 4, retainedFiles: 3 });
    const opened = await logs.open('worktree-1', 'shifted-history');
    await opened.stdout.write('old0');
    const initial = await logs.readCursor(opened.stdoutPath, undefined, 2);
    await opened.close();
    await rename(opened.stdoutPath, `${opened.stdoutPath}.1`);
    await writeFile(opened.stdoutPath, 'new1', { mode: 0o600 });
    await writeFile(`${opened.stdoutPath}.generation`, '1', { mode: 0o600 });
    await rename(`${opened.stdoutPath}.1`, `${opened.stdoutPath}.2`);
    await writeFile(`${opened.stdoutPath}.generation`, 'rotating-1-closed-4242', { mode: 0o600 });

    const during = await logs.readCursor(opened.stdoutPath, initial.cursor, 32);
    expect(during.content).toBe('');
    expect(during.cursor.generation).toBe('0');

    await rename(opened.stdoutPath, `${opened.stdoutPath}.1`);
    await writeFile(opened.stdoutPath, 'new2', { mode: 0o600 });
    await writeFile(`${opened.stdoutPath}.generation`, '2', { mode: 0o600 });
    const after = await logs.readCursor(opened.stdoutPath, during.cursor, 32);
    expect(after.content).toBe('new1new2');
  });

  test('recovers the legacy rotating marker left after current was archived', async () => {
    const logRoot = await root();
    const logs = new ManagedLogStore({ root: logRoot, rotationBytes: 4, retainedFiles: 3 });
    const opened = await logs.open('worktree-1', 'legacy-phase');
    await opened.stdout.write('old!');
    const cursor = (await logs.readCursor(opened.stdoutPath)).cursor;
    await opened.close();
    await writeFile(`${opened.stdoutPath}.generation`, 'rotating-4242-123456', { mode: 0o600 });
    await rename(opened.stdoutPath, `${opened.stdoutPath}.1`);

    const recovered = await logs.readCursor(opened.stdoutPath, cursor);
    expect(recovered.content).toBe('');
    expect(recovered.cursor.generation).toBe('0');
  });

  test('recovery only verifies anchor-owned logs and never mutates their inode or generations', async () => {
    const logRoot = await root();
    const firstStore = new ManagedLogStore({ root: logRoot, rotationBytes: 8, retainedFiles: 3 });
    const opened = await firstStore.open('worktree-1', 'recover');
    await opened.close();
    await firstStore.close();

    await writeFile(opened.stdoutPath, '12345678');
    const before = await lstat(opened.stdoutPath);
    const recoveredStore = new ManagedLogStore({ root: logRoot, rotationBytes: 8, retainedFiles: 3 });
    await recoveredStore.recover(opened.stdoutPath, opened.stderrPath);

    expect(await readFile(opened.stdoutPath, 'utf8')).toBe('12345678');
    expect((await lstat(opened.stdoutPath)).ino).toBe(before.ino);
    expect(await lstat(`${opened.stdoutPath}.1`).then(() => true, () => false)).toBe(false);
    await recoveredStore.close();
  });

  test('recovery never installs maintenance against an inherited writer descriptor', async () => {
    const logRoot = await root();
    const initial = new ManagedLogStore({ root: logRoot, rotationBytes: 8, retainedFiles: 3 });
    const opened = await initial.open('worktree-1', 'inherited');
    await opened.close();
    const inherited = await open(opened.stdoutPath, 'a');
    const recovered = new ManagedLogStore({ root: logRoot, rotationBytes: 8, retainedFiles: 3 });
    try {
      await inherited.write('first---');
      await recovered.recover(opened.stdoutPath, opened.stderrPath);
      await inherited.write('second--');

      expect((await lstat(opened.stdoutPath)).ino).toBe((await inherited.stat()).ino);
      expect(await readFile(opened.stdoutPath, 'utf8')).toBe('first---second--');
      expect(await lstat(`${opened.stdoutPath}.1`).then(() => true, () => false)).toBe(false);
    } finally {
      await inherited.close();
      await recovered.close();
    }
  });

  test('rejects a task-directory symlink swap after final open before exposing the descriptor', async () => {
    const logRoot = await root();
    const outside = await root();
    const taskDirectory = join(logRoot, 'worktree-1', 'race');
    const movedDirectory = join(logRoot, 'worktree-1', 'race-owned');
    let swapped = false;
    const logs = new ManagedLogStore({
      root: logRoot,
      raceHook: async (phase) => {
        if (phase !== 'after-open' || swapped) return;
        swapped = true;
        await rename(taskDirectory, movedDirectory);
        await symlink(outside, taskDirectory);
      },
    });

    await expect(logs.open('worktree-1', 'race')).rejects.toThrow('Unsafe managed log directory');
    expect(await lstat(join(outside, 'stdout.log')).then(() => true, () => false)).toBe(false);
  });

  test('rejects a parent swap immediately after read open without returning external content', async () => {
    const logRoot = await root();
    const initial = new ManagedLogStore({ root: logRoot });
    const opened = await initial.open('worktree-1', 'read-race');
    await opened.stdout.write('owned');
    await opened.close();
    const outside = await root();
    await writeFile(join(outside, 'stdout.log'), 'external');
    const taskDirectory = join(logRoot, 'worktree-1', 'read-race');
    const movedDirectory = join(logRoot, 'worktree-1', 'read-race-owned');
    const logs = new ManagedLogStore({
      root: logRoot,
      raceHook: async (phase) => {
        if (phase !== 'after-read-open') return;
        await rename(taskDirectory, movedDirectory);
        await symlink(outside, taskDirectory);
      },
    });

    await expect(logs.read(opened.stdoutPath)).rejects.toThrow('Unsafe managed log directory');
    expect(await readFile(join(outside, 'stdout.log'), 'utf8')).toBe('external');
  });

  test('rejects an intermediate-directory swap before rotation without touching external files', async () => {
    const logRoot = await root();
    const initial = new ManagedLogStore({ root: logRoot, rotationBytes: 8 });
    const opened = await initial.open('worktree-1', 'rotate-race');
    await opened.stdout.write('12345678');
    await opened.close();
    const outside = await root();
    await writeFile(join(outside, 'stdout.log'), 'external');
    const taskDirectory = join(logRoot, 'worktree-1', 'rotate-race');
    const movedDirectory = join(logRoot, 'worktree-1', 'rotate-race-owned');
    let swapped = false;
    const logs = new ManagedLogStore({
      root: logRoot,
      rotationBytes: 8,
      raceHook: async (phase) => {
        if (phase !== 'before-rotate-operation' || swapped) return;
        swapped = true;
        await rename(taskDirectory, movedDirectory);
        await symlink(outside, taskDirectory);
      },
    });

    await expect(logs.rotate([opened.stdoutPath])).rejects.toThrow('Unsafe managed log directory');
    expect(await readFile(join(outside, 'stdout.log'), 'utf8')).toBe('external');
    expect(await lstat(join(outside, 'stdout.log.1')).then(() => true, () => false)).toBe(false);
  });
});
