import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeFileTrust } from '../../../core/src/resources/__tests__/file-trust-fixture';
import { ManagedLogStore } from '../logs';

const mode = process.argv[2];
const root = await fs.mkdtemp(join(tmpdir(), 'wtm-completion-path-'));
const logs = new ManagedLogStore({ root: join(root, 'logs'), fileTrust: createFakeFileTrust() });
const originalOpen = fs.open;
const handles: Array<Awaited<ReturnType<typeof fs.open>>> = [];
const completion = { pid: 17, exitCode: 0, signal: null, completedAt: '2026-09-09T00:00:00.000Z', logFailed: false, timedOut: false };
const outsideCompletion = { ...completion, exitCode: 7 };
let raced = false;
let cursorRaceArmed = false;
let generationOpens = 0;
let replacements = 0;

try {
  const paths = await logs.prepare('worktree', 'job-identity');
  const marker = paths.completionMarkerPath;
  const generation = `${paths.stdoutPath}.generation`;
  const saved = join(root, 'saved-marker.json');
  const outside = join(root, 'outside.json');
  await fs.writeFile(outside, JSON.stringify(outsideCompletion), { mode: 0o600 });

  // Model missing O_NOFOLLOW protection for completion reads and atomic publication during
  // cursor reads. All metadata, symlinks, descriptors and bytes stay real in this child.
  fs.open = async (...args: Parameters<typeof fs.open>) => {
    if (cursorRaceArmed && String(args[0]) === generation) {
      generationOpens += 1;
      if (mode === 'generation-churn' || mode === 'generation-initial' && generationOpens === 1
        || mode === 'generation-final' && generationOpens === 2) {
        replacements += 1;
        if (mode !== 'generation-churn') {
          await fs.rename(paths.stdoutPath, `${paths.stdoutPath}.1`);
          await fs.writeFile(paths.stdoutPath, 'new!', { mode: 0o600 });
        }
        const temporary = join(root, `generation-${replacements}`);
        await fs.writeFile(temporary, mode === 'generation-churn' ? '0' : '1', { mode: 0o600 });
        await fs.rename(temporary, generation);
      }
      const handle = await originalOpen(...args);
      handles.push(handle);
      return handle;
    }
    if (cursorRaceArmed && mode === 'segment-identity' && String(args[0]) === paths.stdoutPath && !raced) {
      raced = true;
      await fs.rename(paths.stdoutPath, `${paths.stdoutPath}.1`);
      await fs.writeFile(paths.stdoutPath, 'new!', { mode: 0o600 });
      const handle = await originalOpen(...args);
      handles.push(handle);
      return handle;
    }
    if (String(args[0]) !== marker) return originalOpen(...args);
    const flags = typeof args[1] === 'number' ? args[1] & ~(constants.O_NOFOLLOW ?? 0) : args[1];
    if (!raced && mode === 'transient-symlink') {
      raced = true;
      await fs.rename(marker, saved);
      await fs.symlink(outside, marker, 'file');
      try {
        const handle = await originalOpen(args[0], flags, args[2]);
        handles.push(handle);
        return handle;
      } finally {
        await fs.unlink(marker);
        await fs.rename(saved, marker);
      }
    }
    const handle = await originalOpen(args[0], flags, args[2]);
    handles.push(handle);
    if (!raced && mode === 'replaced-after-open') {
      raced = true;
      await fs.rename(marker, saved);
      await fs.writeFile(marker, JSON.stringify(outsideCompletion), { mode: 0o600 });
    }
    return handle;
  };
  syncBuiltinESMExports();

  if (mode === 'existing-symlink' || mode === 'dangling-symlink') {
    await fs.symlink(mode === 'existing-symlink' ? outside : join(root, 'missing.json'), marker, 'file');
    await assert.rejects(logs.readCompletion(paths.stdoutPath, 17), /Unsafe managed log target/);
    assert.equal((await fs.lstat(marker)).isSymbolicLink(), true, 'read rejection must preserve the link');
  } else if (mode === 'transient-symlink' || mode === 'replaced-after-open') {
    await fs.writeFile(marker, JSON.stringify(completion), { mode: 0o600 });
    const before = await fs.lstat(marker);
    await assert.rejects(logs.readCompletion(paths.stdoutPath, 17), /managed log.*(identity|changed)/i);
    assert.equal(raced, true, 'the race must happen after the initial inspection');
    assert.equal((await fs.lstat(marker)).isSymbolicLink(), false);
    if (mode === 'transient-symlink') {
      const restored = await fs.lstat(marker);
      assert.equal(restored.dev, before.dev);
      assert.equal(restored.ino, before.ino, 'restoring the original path must not hide the foreign opened descriptor');
      assert.equal(await fs.readFile(marker, 'utf8'), JSON.stringify(completion));
    } else {
      assert.equal(await fs.readFile(saved, 'utf8'), JSON.stringify(completion));
      assert.equal(await fs.readFile(marker, 'utf8'), JSON.stringify(outsideCompletion));
    }
  } else if (mode === 'missing-and-valid') {
    assert.equal(await logs.readCompletion(paths.stdoutPath, 17), null);
    assert.equal(await logs.hasLaunchAcknowledgement(paths.stdoutPath, 17), false);
    await fs.writeFile(marker, JSON.stringify(completion), { mode: 0o600 });
    assert.deepEqual(await logs.readCompletion(paths.stdoutPath, 17), completion);
    await assert.rejects(logs.readCompletion(paths.stdoutPath, 18), /completion identity/);
  } else if (mode === 'generation-initial' || mode === 'generation-final' || mode === 'generation-churn' || mode === 'segment-identity') {
    await fs.writeFile(paths.stdoutPath, 'old!', { mode: 0o600 });
    await fs.writeFile(generation, '0', { mode: 0o600 });
    const first = await logs.readCursor(paths.stdoutPath);
    await fs.appendFile(paths.stdoutPath, 'd');
    if (mode === 'segment-identity') await fs.writeFile(generation, 'rotating-0-closed-first', { mode: 0o600 });
    cursorRaceArmed = true;
    if (mode === 'generation-churn') {
      await assert.rejects(logs.readCursor(paths.stdoutPath, first.cursor), /rotated during bounded read/);
      assert.equal(replacements, 3, 'persistent identity churn must stop at the existing three-attempt bound');
      assert.equal(generationOpens, 3);
    } else {
      const next = await logs.readCursor(paths.stdoutPath, first.cursor);
      if (mode === 'segment-identity') {
        assert.equal(raced, true);
        assert.equal(next.content, 'd', 'a stable in-progress marker still permits retrying a segment shift');
        await fs.writeFile(generation, '1', { mode: 0o600 });
        const completed = await logs.readCursor(paths.stdoutPath, next.cursor);
        assert.equal(completed.content, 'new!');
        assert.equal((await logs.readCursor(paths.stdoutPath, completed.cursor)).content, '');
      } else {
        assert.equal(replacements, 1);
        assert.equal(next.content, 'dnew!', 'retry must neither skip nor duplicate the old cursor tail');
        assert.equal(next.cursor.rotated, true);
        assert.equal((await logs.readCursor(paths.stdoutPath, next.cursor)).content, '');
      }
    }
  } else if (mode === 'rotation') {
    await fs.writeFile(paths.stdoutPath, 'old!', { mode: 0o600 });
    const first = await logs.readCursor(paths.stdoutPath);
    assert.equal(first.content, 'old!');
    await fs.rename(paths.stdoutPath, `${paths.stdoutPath}.1`);
    await fs.writeFile(paths.stdoutPath, 'new!', { mode: 0o600 });
    await fs.writeFile(`${paths.stdoutPath}.generation`, '1', { mode: 0o600 });
    const next = await logs.readCursor(paths.stdoutPath, first.cursor);
    assert.equal(next.content, 'new!');
    assert.equal(next.cursor.rotated, true);
    assert.equal((await logs.readCursor(paths.stdoutPath, next.cursor)).content, '');
  } else throw new Error(`Unknown completion path scenario: ${mode}`);

  assert.equal(await fs.readFile(outside, 'utf8'), JSON.stringify(outsideCompletion), 'rejection must never alter the external file');
  assert.ok(handles.every((handle) => handle.fd < 0), 'rejected and accepted reads must close every completion descriptor');
  console.log(JSON.stringify({ ok: true }));
} finally {
  fs.open = originalOpen;
  syncBuiltinESMExports();
  await Promise.allSettled(handles.map((handle) => handle.close()));
  await logs.close();
  await fs.rm(root, { recursive: true, force: true });
}
