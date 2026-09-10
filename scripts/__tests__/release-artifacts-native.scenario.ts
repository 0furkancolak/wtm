import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReleaseArtifacts, createReleaseHost, releaseArchiveFiles } from '../release-artifacts';

const repository = resolve(fileURLToPath(import.meta.url), '../../..');

function command(file: string, args: readonly string[]) {
  const result = spawnSync(file, [...args], { encoding: 'utf8', timeout: 15_000, maxBuffer: 256 * 1024 });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`${file} failed (${result.status ?? result.signal}): ${result.stderr}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function digest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Real Linux packaging evidence. The default fixture is a small ELF, not a WTM/SEA acceptance claim. */
export async function runNativeArchiveScenario(executable = '/usr/bin/true') {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('This native archive scenario requires Linux x64');
  const root = mkdtempSync(join(tmpdir(), 'wtm-native-archive-'));
  try {
    mkdirSync(join(root, 'dist/sea'), { recursive: true });
    copyFileSync(executable, join(root, 'dist/sea/wtm'));
    for (const file of releaseArchiveFiles.filter((name) => name !== 'wtm')) {
      copyFileSync(join(repository, file), join(root, file));
    }
    const expectedDigest = await digest(join(root, 'dist/sea/wtm'));
    const host = createReleaseHost();
    host.root = root;
    // The scenario supplies a child timeout; archive construction and header reads are production code.
    host.run = command;
    const result = await buildReleaseArtifacts(host);
    const archiveName = basename(result.archive);
    assert.equal(archiveName, 'wtm-linux-x64.tar.gz');
    const archiveDigest = await digest(result.archive);
    assert.equal(result.sha256, archiveDigest);
    assert.equal(readFileSync(result.checksums, 'utf8'), `${archiveDigest}  ${archiveName}\n`);
    const members = command('/usr/bin/tar', ['-tzf', result.archive]).stdout.trim().split('\n');
    assert.deepEqual(members, [...releaseArchiveFiles]);
    const listing = command('/usr/bin/tar', ['--numeric-owner', '-tvzf', result.archive]).stdout.trim().split('\n');
    assert.equal(listing.length, releaseArchiveFiles.length);
    assert.ok(listing.every((line) => /^\S+\s+0\/0\s/.test(line)), 'Every archive entry must have numeric owner/group 0/0');
    const extracted = join(root, 'extracted');
    mkdirSync(extracted);
    command('/usr/bin/tar', ['-xzf', result.archive, '-C', extracted]);
    assert.deepEqual(readdirSync(extracted).sort(), [...releaseArchiveFiles].sort());
    const mode = statSync(join(extracted, 'wtm')).mode & 0o777;
    assert.equal(mode, 0o755);
    assert.equal(await digest(join(extracted, 'wtm')), expectedDigest);
    for (const file of releaseArchiveFiles.filter((name) => name !== 'wtm')) {
      assert.equal(await digest(join(extracted, file)), await digest(join(root, file)));
    }
    const smoke = command(join(extracted, 'wtm'), ['--version']);
    return { platform: process.platform, arch: process.arch, inputExecutable: resolve(executable),
      archiveName, members, mode, archiveBytes: statSync(result.archive).size,
      archiveDigest, executableDigest: expectedDigest, smokeExitCode: smoke.status,
      smokeOutput: smoke.stdout.trim() };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

if (import.meta.main) {
  process.stdout.write(`${JSON.stringify(await runNativeArchiveScenario(process.argv[2]))}\n`);
}
