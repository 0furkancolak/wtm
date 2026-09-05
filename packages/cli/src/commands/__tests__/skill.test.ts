import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmod,
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
import { createWindowsFileTrustPolicy } from '@wtm/platform';
import type { FileTrustPolicy } from '@wtm/platform/ports';
import {
  canonicalSkillPathForModule,
  createFilesystemSkillInstaller,
  readCanonicalSkill,
  runSkillInstallCommand,
} from '../skill';

const canonicalSkillPath = resolve(import.meta.dir, '../../../../../skills/wtm/SKILL.md');
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
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error('POSIX uid is unavailable in the test runtime');
    expect(localStat.isFile()).toBe(true);
    expect(localStat.uid).toBe(uid);
    expect(localStat.nlink).toBe(1);
    expect(localStat.mode & 0o777).toBe(0o644);
  });

  test('updates only the selected SKILL.md and never creates or modifies AGENTS.md', async () => {
    const root = await temporaryRoot();
    const project = join(root, 'project');
    const agentsPath = join(project, 'AGENTS.md');
    await mkdir(project, { recursive: true });
    await chmod(project, 0o755);
    await writeFile(agentsPath, 'user-owned instructions\n');
    const installer = createFilesystemSkillInstaller({
      localAnchor: project,
      localSkills: join(project, '.vendor', 'skills'),
      globalAnchor: root,
      globalSkills: join(root, 'global-skills'),
    });

    await runSkillInstallCommand({ scope: 'local', installer });

    expect(await readFile(agentsPath, 'utf8')).toBe('user-owned instructions\n');
    expect((await stat(project)).mode & 0o777).toBe(0o755);
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
      await chmod(project, insecure === 'anchor' ? 0o777 : 0o755);
      await chmod(intermediate, insecure === 'intermediate' ? 0o777 : 0o755);
      const installer = createFilesystemSkillInstaller({
        localAnchor: project,
        localSkills: join(intermediate, 'skills'),
        globalAnchor: root,
        globalSkills: join(root, 'global'),
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
    });

    await expect(runSkillInstallCommand({ scope: 'local', installer })).rejects.toThrow(
      'Agent Skill destination contains an unsafe path component.',
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
