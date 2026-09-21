import { afterEach, describe, expect, test } from 'bun:test';
import {
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createWindowsFileTrustPolicy, selectPlatformRuntime } from '@wtm/platform';
import type { FileTrustPolicy } from '@wtm/platform/ports';
import {
  grantForeignDirectoryAccess,
  grantForeignDirectoryWrite,
} from '../../../../testkit/src/directory-access';
import { isWindowsTestHost } from '../../../../testkit/src/platform';
import {
  canonicalSkillPathForModule,
  createFilesystemSkillInstaller,
  readCanonicalSkill,
  runSkillInstallCommand,
} from '../skill';

const canonicalSkillPath = resolve(import.meta.dir, '../../../../../skills/wtm/SKILL.md');

/**
 * The policy `main.ts` selects, selected here for the same reason.
 *
 * `createFilesystemSkillInstaller`'s own fallback is `@wtm/core`'s POSIX-only default, whose
 * `currentIdentityAvailable()` is `process.getuid?.() !== undefined` -- always false on win32. A
 * test that injected nothing was not exercising the installer there: `directoryIdentity` refused
 * the anchor on its first question, so every case below reported
 * `Agent Skill destination contains an unsafe path component` whatever it had set up, and the two
 * cases that expect exactly that message passed for a reason unrelated to what they name. Only the
 * stub-injecting tests further down pick a different policy, deliberately.
 */
const hostFileTrust: FileTrustPolicy = selectPlatformRuntime().fileTrust;
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Agent Skill command', () => {
  test('reads exactly the canonical shipped SKILL.md bytes', async () => {
    const expected = await readFile(canonicalSkillPath, 'utf8');

    expect(await readCanonicalSkill()).toBe(expected);
  });

  // Fixture URLs below are POSIX-shaped (`file:///workspace/...`, no drive letter) purely to
  // exercise the segment-name matching (`basename`/`dirname` walking up the module directory) —
  // they never touch a real path. Node's own `fileURLToPath` rejects a driveless `file:///...`
  // URL on win32 before this function's logic ever runs, which a real Windows `import.meta.url`
  // (always drive-lettered) never hits, so there is no Windows behaviour left unproven by skipping
  // this one.
  test.skipIf(process.platform === 'win32')(
    'selects canonical skill paths by an exact source or bundle layout, never by an existing ancestor', () => {
    expect(canonicalSkillPathForModule('file:///workspace/packages/cli/src/commands/skill.ts')).toBe(
      '/workspace/skills/wtm/SKILL.md',
    );
    expect(canonicalSkillPathForModule('file:///workspace/dist/cli/index.js')).toBe(
      '/workspace/dist/cli/skills/wtm/SKILL.md',
    );
    expect(() => canonicalSkillPathForModule('file:///workspace/other/cli/index.js')).toThrow(
      'The WTM Agent Skill runtime layout is unsupported.',
    );
  });

  test('installs the canonical skill through injectable local and global vendor locations', async () => {
    const root = await temporaryRoot();
    const localSkills = join(root, 'project-vendor-skills');
    const globalSkills = join(root, 'user-vendor-skills');
    const installer = createFilesystemSkillInstaller({
      localAnchor: root,
      localSkills,
      globalAnchor: root,
      globalSkills,
      fileTrust: hostFileTrust,
    });
    const expected = await readFile(canonicalSkillPath, 'utf8');

    const local = await runSkillInstallCommand({ scope: 'local', installer });
    const global = await runSkillInstallCommand({ scope: 'global', installer });
    const localUpdate = await runSkillInstallCommand({ scope: 'local', installer });

    expect(local).toEqual({ scope: 'local', path: join(localSkills, 'wtm', 'SKILL.md') });
    expect(global).toEqual({ scope: 'global', path: join(globalSkills, 'wtm', 'SKILL.md') });
    expect(localUpdate).toEqual(local);
    expect(await readFile(local.path, 'utf8')).toBe(expected);
    expect(await readFile(global.path, 'utf8')).toBe(expected);
    const localStat = await lstat(local.path);
    expect(localStat.isFile()).toBe(true);
    expect(localStat.nlink).toBe(1);
    // Owner and mode are the POSIX half of "the file it published is the file it meant to".
    // Windows records neither -- `uid` is hardcoded `0` and `mode` comes from the read-only
    // attribute -- so asserting them there measures Node's synthesis, not the installer. The two
    // lines above are the part that means the same thing on every platform, and they stay.
    if (!isWindowsTestHost) {
      const uid = process.getuid?.();
      if (uid === undefined) throw new Error('POSIX uid is unavailable in the test runtime');
      expect(localStat.uid).toBe(uid);
      expect(localStat.mode & 0o777).toBe(0o644);
    }
  });

  test('updates only the selected SKILL.md and never creates or modifies AGENTS.md', async () => {
    const root = await temporaryRoot();
    const project = join(root, 'project');
    const agentsPath = join(project, 'AGENTS.md');
    await mkdir(project, { recursive: true });
    await grantForeignDirectoryAccess(project);
    await writeFile(agentsPath, 'user-owned instructions\n');
    const installer = createFilesystemSkillInstaller({
      localAnchor: project,
      localSkills: join(project, '.vendor', 'skills'),
      globalAnchor: root,
      globalSkills: join(root, 'global-skills'),
      fileTrust: hostFileTrust,
    });

    await runSkillInstallCommand({ scope: 'local', installer });

    expect(await readFile(agentsPath, 'utf8')).toBe('user-owned instructions\n');
    // The anchor's own permissions are the caller's, not the installer's to tighten. Only the
    // POSIX half of that is readable from a mode; on Windows the equivalent evidence is the ACL,
    // which this test has no reason to read when `AGENTS.md` above already pins the intent.
    if (!isWindowsTestHost) expect((await stat(project)).mode & 0o777).toBe(0o755);
    expect(await readFile(join(project, '.vendor', 'skills', 'wtm', 'SKILL.md'), 'utf8')).toContain(
      '# WTM Worktree Runtime',
    );
  });

  test('rejects an existing destination symlink and preserves both link and referent', async () => {
    const root = await temporaryRoot();
    const localSkills = join(root, 'skills');
    const targetDirectory = join(localSkills, 'wtm');
    const agentsPath = join(root, 'AGENTS.md');
    await mkdir(targetDirectory, { recursive: true });
    await writeFile(agentsPath, 'do not overwrite\n');
    await symlink(agentsPath, join(targetDirectory, 'SKILL.md'));

    await expect(runSkillInstallCommand({
      scope: 'local',
      installer: createFilesystemSkillInstaller({
        localAnchor: root,
        localSkills,
        globalAnchor: root,
        globalSkills: join(root, 'global'),
        fileTrust: hostFileTrust,
      }),
    })).rejects.toThrow('Agent Skill destination is unsafe.');

    expect(await readFile(agentsPath, 'utf8')).toBe('do not overwrite\n');
    expect((await lstat(join(targetDirectory, 'SKILL.md'))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(targetDirectory, 'SKILL.md'))).toBe(agentsPath);
  });

  test('rejects symlinked local vendor path components without writing outside the project', async () => {
    for (const component of ['.agents', 'skills'] as const) {
      const root = await temporaryRoot();
      const project = join(root, 'project');
      const outside = join(root, `outside-${component.slice(1)}`);
      await mkdir(project, { recursive: true });
      await mkdir(outside, { recursive: true });
      if (component === '.agents') {
        await symlink(outside, join(project, '.agents'));
      } else {
        await mkdir(join(project, '.agents'));
        await symlink(outside, join(project, '.agents', 'skills'));
      }
      const installer = createFilesystemSkillInstaller({
        localAnchor: project,
        localSkills: join(project, '.agents', 'skills'),
        globalAnchor: root,
        globalSkills: join(root, 'global-skills'),
        fileTrust: hostFileTrust,
      });

      await expect(runSkillInstallCommand({ scope: 'local', installer })).rejects.toThrow(
        'Agent Skill destination contains an unsafe path component.',
      );
      expect(await exists(join(outside, 'wtm', 'SKILL.md'))).toBe(false);
    }
  });

  test('rejects traversal in adapter skill names without creating an escaped directory', async () => {
    const root = await temporaryRoot();
    const localSkills = join(root, 'skills');
    const installer = createFilesystemSkillInstaller({
      localAnchor: root,
      localSkills,
      globalAnchor: root,
      globalSkills: join(root, 'global-skills'),
      fileTrust: hostFileTrust,
    });

    await expect(installer.install({
      name: '../escaped',
      scope: 'local',
      content: 'malicious replacement',
    })).rejects.toThrow('Agent Skill name must be one safe path segment.');
    expect(await exists(join(root, 'escaped', 'SKILL.md'))).toBe(false);
  });

  test('filesystem adapter refuses non-canonical bytes before creating a destination', async () => {
    const root = await temporaryRoot();
    const localSkills = join(root, 'skills');
    const installer = createFilesystemSkillInstaller({
      localAnchor: root,
      localSkills,
      globalAnchor: root,
      globalSkills: join(root, 'global'),
      fileTrust: hostFileTrust,
    });

    await expect(installer.install({ name: 'wtm', scope: 'local', content: 'different bytes' })).rejects.toThrow(
      'Filesystem installation accepts only the canonical bounded WTM Agent Skill.',
    );
    expect(await exists(join(localSkills, 'wtm', 'SKILL.md'))).toBe(false);
  });

  test('rejects group-or-other-writable anchors and intermediate directories', async () => {
    for (const insecure of ['anchor', 'intermediate'] as const) {
      const root = await temporaryRoot();
      const project = join(root, 'project');
      const intermediate = join(project, '.agents');
      await mkdir(intermediate, { recursive: true });
      // `0o777` and `0o755` in each platform's own terms: the insecure one is writable by a
      // principal that is neither the owner nor trusted, which fails the `0o022` mask this call
      // site asks, and the other is readable by one, which passes it. On win32 a `chmod` said
      // neither -- it left both directories owner-only, so the loop asserted a refusal that had
      // nothing to refuse.
      await (insecure === 'anchor'
        ? grantForeignDirectoryWrite(project) : grantForeignDirectoryAccess(project));
      await (insecure === 'intermediate'
        ? grantForeignDirectoryWrite(intermediate) : grantForeignDirectoryAccess(intermediate));
      const installer = createFilesystemSkillInstaller({
        localAnchor: project,
        localSkills: join(intermediate, 'skills'),
        globalAnchor: root,
        globalSkills: join(root, 'global'),
        fileTrust: hostFileTrust,
      });

      await expect(runSkillInstallCommand({ scope: 'local', installer })).rejects.toThrow(
        'Agent Skill destination contains an unsafe path component.',
      );
      expect(await exists(join(intermediate, 'skills', 'wtm', 'SKILL.md'))).toBe(false);
    }
  });

  test('detects a hardlinked temporary and never publishes it', async () => {
    const root = await temporaryRoot();
    const localSkills = join(root, 'skills');
    const hardlinkPath = join(root, 'retained-hardlink');
    const installer = createFilesystemSkillInstaller({
      localAnchor: root,
      localSkills,
      globalAnchor: root,
      globalSkills: join(root, 'global'),
      hooks: {
        afterTemporarySync: async ({ temporaryPath }) => link(temporaryPath, hardlinkPath),
      },
      fileTrust: hostFileTrust,
    });

    await expect(runSkillInstallCommand({ scope: 'local', installer })).rejects.toThrow(
      'Agent Skill temporary file is unsafe.',
    );
    expect(await exists(join(localSkills, 'wtm', 'SKILL.md'))).toBe(false);
    expect(await readFile(hardlinkPath, 'utf8')).toBe(await readFile(canonicalSkillPath, 'utf8'));
  });

  test('preserves a raced temporary replacement after losing exact identity', async () => {
    const root = await temporaryRoot();
    const localSkills = join(root, 'skills');
    let replacementPath = '';
    let retainedPath = '';
    const installer = createFilesystemSkillInstaller({
      localAnchor: root,
      localSkills,
      globalAnchor: root,
      globalSkills: join(root, 'global'),
      hooks: {
        afterTemporarySync: async ({ temporaryPath }) => {
          replacementPath = temporaryPath;
          retainedPath = join(root, 'retained-original');
          await rename(temporaryPath, retainedPath);
          await writeFile(temporaryPath, 'raced replacement', { flag: 'wx' });
        },
      },
      fileTrust: hostFileTrust,
    });

    await expect(runSkillInstallCommand({ scope: 'local', installer })).rejects.toThrow(
      'Agent Skill temporary file is unsafe.',
    );
    expect(await readFile(replacementPath, 'utf8')).toBe('raced replacement');
    expect(await readFile(retainedPath, 'utf8')).toBe(await readFile(canonicalSkillPath, 'utf8'));
    expect(await exists(join(localSkills, 'wtm', 'SKILL.md'))).toBe(false);
  });

  test('rechecks directory identity after the pre-write hook and writes nothing outside', async () => {
    const root = await temporaryRoot();
    const localSkills = join(root, 'skills');
    const outside = join(root, 'outside');
    await mkdir(outside);
    const installer = createFilesystemSkillInstaller({
      localAnchor: root,
      localSkills,
      globalAnchor: root,
      globalSkills: join(root, 'global'),
      hooks: {
        beforeTemporaryOpen: async ({ targetDirectory }) => {
          await rename(targetDirectory, `${targetDirectory}.parked`);
          await symlink(outside, targetDirectory);
        },
      },
      fileTrust: hostFileTrust,
    });

    await expect(runSkillInstallCommand({ scope: 'local', installer })).rejects.toThrow(
      'Agent Skill destination contains an unsafe path component.',
    );
    expect(await exists(join(outside, 'SKILL.md'))).toBe(false);
  });

  test('rechecks directory identity after final verification and does not publish outside', async () => {
    const root = await temporaryRoot();
    const localSkills = join(root, 'skills');
    const outside = join(root, 'outside');
    await mkdir(outside);
    const installer = createFilesystemSkillInstaller({
      localAnchor: root,
      localSkills,
      globalAnchor: root,
      globalSkills: join(root, 'global'),
      hooks: {
        beforePublication: async ({ targetDirectory }) => {
          await rename(targetDirectory, `${targetDirectory}.parked`);
          await symlink(outside, targetDirectory);
        },
      },
      fileTrust: hostFileTrust,
    });

    // Unlike the pre-write hook above, `beforePublication` fires after the installer has already
    // opened its own handle to a file inside `targetDirectory`. On POSIX an open file descriptor
    // follows the inode rather than the path, so the rename above succeeds silently and it is the
    // installer's own post-hook identity recheck that has to catch the switch -- the specific
    // rejection asserted below. A real win32 leg measured that same `rename` throwing `EPERM`
    // instead: NTFS refuses to rename a directory while a handle to a file inside it is open, so
    // the attack this test simulates cannot reach the installer's check at all there. That is a
    // stronger guarantee than the one this test exists to pin, not a gap in it, so this asserts
    // the security property both platforms actually deliver -- nothing publishes outside the
    // anchor -- rather than the one POSIX-only code path that proves it.
    await expect(runSkillInstallCommand({ scope: 'local', installer })).rejects.toThrow(
      isWindowsTestHost ? /EPERM/u : 'Agent Skill destination contains an unsafe path component.',
    );
    expect(await exists(join(outside, 'SKILL.md'))).toBe(false);
  });

  test('refuses installation when the injected FileTrustPolicy cannot determine the current identity', async () => {
    const root = await temporaryRoot();
    const localSkills = join(root, 'skills');
    const noIdentity: FileTrustPolicy = {
      isOwnedByCurrentUser: async () => false,
      isWritableOnlyByOwner: async () => false,
      isNotSharedByHardLink: () => false,
      currentIdentityAvailable: () => false,
      isExecutable: async () => false,
    };
    const installer = createFilesystemSkillInstaller({
      localAnchor: root,
      localSkills,
      globalAnchor: root,
      globalSkills: join(root, 'global'),
      fileTrust: noIdentity,
    });

    await expect(runSkillInstallCommand({ scope: 'local', installer })).rejects.toThrow(
      'Agent Skill destination contains an unsafe path component.',
    );
    expect(await exists(join(localSkills, 'wtm', 'SKILL.md'))).toBe(false);
  });

  test('installs through a Windows-shaped ACL FileTrustPolicy that is genuinely consulted for every check', async () => {
    const root = await temporaryRoot();
    const localSkills = join(root, 'skills');
    const ownerSid = 'S-1-5-21-1-2-3-1001';
    let aclReads = 0;
    const windowsFileTrust = createWindowsFileTrustPolicy({
      readAcl: async () => {
        aclReads += 1;
        return { ownerSid, accessRules: [] };
      },
      currentUserSid: async () => ownerSid,
    });
    const installer = createFilesystemSkillInstaller({
      localAnchor: root,
      localSkills,
      globalAnchor: root,
      globalSkills: join(root, 'global'),
      fileTrust: windowsFileTrust,
    });

    const result = await runSkillInstallCommand({ scope: 'local', installer });

    expect(result).toEqual({ scope: 'local', path: join(localSkills, 'wtm', 'SKILL.md') });
    expect(await readFile(result.path, 'utf8')).toBe(await readFile(canonicalSkillPath, 'utf8'));
    expect(aclReads).toBeGreaterThan(0);
  });

  test('rejects installation when a Windows-shaped ACL FileTrustPolicy denies ownership of the anchor', async () => {
    const root = await temporaryRoot();
    const localSkills = join(root, 'skills');
    const windowsFileTrust = createWindowsFileTrustPolicy({
      readAcl: async () => ({ ownerSid: 'S-1-5-21-1-2-3-9999', accessRules: [] }),
      currentUserSid: async () => 'S-1-5-21-1-2-3-1001',
    });
    const installer = createFilesystemSkillInstaller({
      localAnchor: root,
      localSkills,
      globalAnchor: root,
      globalSkills: join(root, 'global'),
      fileTrust: windowsFileTrust,
    });

    await expect(runSkillInstallCommand({ scope: 'local', installer })).rejects.toThrow(
      'Agent Skill destination contains an unsafe path component.',
    );
    expect(await exists(join(localSkills, 'wtm', 'SKILL.md'))).toBe(false);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wtm-skill-'));
  temporaryRoots.push(root);
  await mkdir(dirname(root), { recursive: true });
  return root;
}

async function exists(path: string): Promise<boolean> {
  return readFile(path).then(() => true).catch(() => false);
}
