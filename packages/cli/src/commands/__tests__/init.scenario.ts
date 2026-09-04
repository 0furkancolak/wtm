import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { SQLiteStateStore } from '@wtm/core';
import { createWorkspaceFixture } from '../../../../testkit/src/workspace-fixture';
import { writeExecutableFixture } from '../../../../testkit/src/executable-fixture';
import { runInitCommand } from '../init';
import type { SkillInstaller } from '../skill';

const scenario = process.argv[2];
if (scenario === undefined) throw new Error('Scenario name is required');

const fixture = await createWorkspaceFixture();
const databasePath = join(fixture.userDataDir, 'state.db');
let store = new SQLiteStateStore(databasePath);
try {
  if (scenario === 'git-failure') await installFailingGit(fixture.userDataDir, fixture.firstRepoPath);
  if (scenario === 'config-context') {
    await writeFile(join(fixture.root, 'wtm.toml'), '[workspace]\nname = 42\n');
  }
  if (scenario === 'update-required-secret') {
    await writeFile(
      join(fixture.root, 'wtm.toml'),
      '[workspace]\nname = "cli-user-authored-name"\n\n[environment]\nAPI_TOKEN = "cli-environment-secret"\n',
    );
  }
  if (scenario === 'malformed-secret') {
    await writeFile(
      join(fixture.root, 'wtm.toml'),
      'version = 1\n\n[workspace]\nname = "valid-name"\n\n[environment]\nAPI_TOKEN = "cli-unterminated-secret-token-value\n',
    );
  }
  let installs = 0;
  const installer: SkillInstaller = {
    async install() {
      installs += 1;
      if (scenario === 'skill-failure') {
        throw new Error('installer-secret at /private/vendor/path');
      }
      return { path: join(fixture.root, '.agent-skills', 'wtm', 'SKILL.md') };
    },
  };
  const agentsPath = join(fixture.root, 'AGENTS.md');
  if (scenario === 'skill-install' || scenario === 'no-ai-skill' || scenario === 'default-no-skill') {
    await writeFile(agentsPath, 'project-owned instructions\n');
  }
  const input = {
    root: scenario === 'git-failure' ? fixture.firstRepoPath : fixture.root,
    maxDepth: scenario === 'failure' || scenario === 'core-failure-no-install' ? -1 : 5,
    userDataDir: fixture.userDataDir,
    stateStore: store,
    ...(scenario === 'success' ? { acceptDefaults: true } : {}),
    ...((scenario === 'skill-install' || scenario === 'no-ai-skill' || scenario === 'skill-failure'
      || scenario === 'core-failure-no-install') ? {
      aiSkillInstaller: installer,
      installAiSkill: scenario !== 'no-ai-skill',
    } : {}),
    // An installer is available and nothing asked for it: registering must still write only
    // `wtm.toml`, and leave the project without a `.agents` tree it did not ask for.
    ...(scenario === 'default-no-skill' ? { aiSkillInstaller: installer } : {}),
  };
  const envelope = await runInitCommand(input);
  if (scenario === 'skill-install' || scenario === 'no-ai-skill' || scenario === 'default-no-skill') {
    process.stdout.write(`${JSON.stringify({
      ok: envelope.ok,
      installs,
      aiSkill: envelope.data?.aiSkill,
      confirmation: envelope.data?.confirmation,
      agentsContent: await readFile(agentsPath, 'utf8'),
    })}\n`);
  } else if (scenario === 'core-failure-no-install') {
    process.stdout.write(`${JSON.stringify({ ok: envelope.ok, installs })}\n`);
  } else if (scenario === 'skill-failure') {
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
  } else if (scenario !== 'success') {
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
  } else {
    if (!envelope.ok || envelope.data === null) throw new Error('First init unexpectedly failed');
    const initialWorktrees = envelope.data.repositories
      .flatMap((entry) => entry.reconciliation.discovered)
      .map((worktree) => [worktree.path, worktree.id, worktree.numericId])
      .sort(([left], [right]) => String(left).localeCompare(String(right)));
    store.close();
    store = new SQLiteStateStore(databasePath);
    const reopened = await runInitCommand({ ...input, stateStore: store });
    if (!reopened.ok || reopened.data === null) throw new Error('Reopened init unexpectedly failed');
    const reopenedWorktrees = reopened.data.repositories
      .flatMap((entry) => entry.reconciliation.updated)
      .map((worktree) => [worktree.path, worktree.id, worktree.numericId])
      .sort(([left], [right]) => String(left).localeCompare(String(right)));
    process.stdout.write(`${JSON.stringify({
      envelope: reopened,
      stableWorktreeIdsAfterReopen: JSON.stringify(initialWorktrees) === JSON.stringify(reopenedWorktrees),
      reopenedDiscoveredWorktrees: reopened.data.repositories
        .flatMap((entry) => entry.reconciliation.discovered).length,
      reopenedUpdatedWorktrees: reopened.data.repositories
        .flatMap((entry) => entry.reconciliation.updated).length,
    })}\n`);
  }
} finally {
  store.close();
  await fixture.cleanup();
}

async function installFailingGit(directory: string, repoRoot: string): Promise<void> {
  const executableDirectory = join(directory, 'fake-bin');
  await mkdir(executableDirectory, { recursive: true });
  await writeExecutableFixture(join(executableDirectory, 'git'), `const args = process.argv.slice(2);
if (args.includes('rev-parse')) {
  process.stdout.write(${JSON.stringify(`${join(repoRoot, '.git')}\n${repoRoot}\n`)});
  process.exit(0);
}
if (args.includes('config')) process.exit(1);
if (args.includes('worktree')) {
  process.stderr.write('fatal: https://alice:super-secret@example.invalid/private\\n');
  process.exit(7);
}
process.exit(2);
`);
  process.env.PATH = `${executableDirectory}${delimiter}${process.env.PATH ?? ''}`;
}
