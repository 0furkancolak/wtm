import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createWorktree, listGitWorktrees } from '@wtm/core';
import type { CliDependencies } from '../main';

/** Partial multi-repository creations and `--resume`, against real Git and a real state store. */
const root = await realpath(await mkdtemp(join(tmpdir(), 'wtm-create-recovery-')));
const home = join(root, 'home');
const dataRoot = join(home, 'wtm');
const databasePath = join(dataRoot, 'state.db');
const workspaceRoot = join(root, 'ws');
const gitConfig = join(root, 'gitconfig');
const repos = ['web', 'api', 'worker'] as const;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

async function invoke(argv: readonly string[], dependencies: CliDependencies = {}) {
  const { runCli } = await import('../main');
  let out = '';
  const code = await runCli(argv, {
    cwd: workspaceRoot,
    analysisDatabasePath: databasePath,
    diagnosticsDatabasePath: databasePath,
    removalGlobalConfigPath: join(dataRoot, 'config.toml'),
    daemonSocketPath: join(root, 'd.sock'),
    ...dependencies,
    stdout: (value) => { out += value; },
    stderr: () => {},
  });
  return { code, envelope: JSON.parse(out) as { ok: boolean; data: any; warnings: Array<{ code: string; context?: any }>; errors: Array<{ code: string; context?: any; remediation?: any }> } };
}

/** `CliDependencies['featureCreateApply']` without the `| undefined`, so these helpers can be
 * spread into a dependencies object without violating `exactOptionalPropertyTypes`. */
type ApplyWorktree = NonNullable<CliDependencies['featureCreateApply']>;

const create = (argv: string[], dependencies: CliDependencies = {}) => invoke(['create', ...argv, '--json'], dependencies);
const failFor = (name: string): ApplyWorktree => async (repoPath, plan) => {
  if (repoPath.endsWith(`${'/'}${name}`) || repoPath.endsWith(`\\${name}`)) throw new Error(`injected failure in ${name}`);
  return await createWorktree(repoPath, plan);
};
/** Git succeeds for `name`, then the process "crashes" before the journal records it. */
const crashAfterGitFor = (name: string): ApplyWorktree => async (repoPath, plan) => {
  const record = await createWorktree(repoPath, plan);
  if (repoPath.endsWith(`/${name}`) || repoPath.endsWith(`\\${name}`)) throw new Error(`injected crash in ${name}`);
  return record;
};
const alwaysFail: ApplyWorktree = async () => { throw new Error('injected failure'); };
const onDisk = (branch: string) => repos.map((repo) => existsSync(join(workspaceRoot, `${repo}-${branch.replace('/', '-')}`)));
const phases = (envelope: { data: any }) => Object.fromEntries((envelope.data?.members ?? [])
  .map((member: any) => [member.repository.mainRoot.split(/[\\/]/).pop(), member.phase]));
const recoveredFrom = (envelope: { data: any }) => Object.fromEntries((envelope.data?.members ?? [])
  .map((member: any) => [member.repository.mainRoot.split(/[\\/]/).pop(), member.recoveredFrom ?? null]));
const sql = (statement: string, ...parameters: unknown[]) => {
  const database = new Database(databasePath);
  try { return database.prepare(statement).run(...parameters); } finally { database.close(); }
};
const query = (statement: string, ...parameters: unknown[]) => {
  const database = new Database(databasePath);
  try { return database.prepare(statement).all(...parameters); } finally { database.close(); }
};

await mkdir(dataRoot, { recursive: true, mode: 0o700 });
await writeFile(gitConfig, '[safe]\n\tdirectory = *\n');
process.env['HOME'] = home;
process.env['GIT_CONFIG_GLOBAL'] = gitConfig;
process.env['GIT_CONFIG_NOSYSTEM'] = '1';
for (const repo of repos) {
  const path = join(workspaceRoot, repo);
  await mkdir(path, { recursive: true });
  git(path, 'init', '--initial-branch=main');
  git(path, 'config', 'user.name', 'WTM Recovery');
  git(path, 'config', 'user.email', 'wtm-recovery@example.invalid');
  await writeFile(join(path, 'README.md'), `${repo}\n`);
  git(path, 'add', 'README.md');
  git(path, 'commit', '-m', repo);
}
const reconcileOk = { request: async () => ({ schemaVersion: 1, ok: true, command: 'reconcile', data: null, warnings: [], errors: [] }) } as never;
const initialized = await invoke(['init', '--yes', '--json'], { initDatabasePath: databasePath, initUserDataDir: dataRoot, runtimeClient: reconcileOk });
if (initialized.code !== 0) throw new Error('wtm init failed');

// Members are applied in repository id order, and ids are random. Failing the member with the
// highest id makes "every member before it was created" deterministic.
const last = (query('SELECT main_root FROM repositories ORDER BY id DESC LIMIT 1') as Array<{ main_root: string }>)[0]!
  .main_root.split(/[\\/]/).pop()!;
const others = repos.filter((repo) => repo !== last);
const exists = (repo: string, branch: string) => existsSync(join(workspaceRoot, `${repo}-${branch.replace('/', '-')}`));

// 1. A Git failure in one member: the others stay, a plain create is refused, resume finishes.
const partial = await create(['feat/partial', '--repos', 'web,api,worker'], { featureCreateApply: failFor(last) });
const partialFailedOnDisk = exists(last, 'feat/partial');
const partialOthersOnDisk = others.map((repo) => exists(repo, 'feat/partial'));
const plainWhileOpen = await create(['feat/partial', '--repos', 'web,api,worker']);
const resumedPartial = await create(['feat/partial', '--resume']);

// 2. Git finished for a member, but the process died before the journal said so.
const crashed = await create(['feat/crashed', '--repos', 'web,api,worker'], { featureCreateApply: crashAfterGitFor('api') });
const crashedPhaseApi = phases(crashed.envelope)['api'];
const resumedCrashed = await create(['feat/crashed', '--resume']);

// 3. The journal says APPLYING, and Git never started.
const halted = await create(['feat/halted', '--repos', 'web,api,worker'], { featureCreateApply: failFor('api') });
sql(`UPDATE feature_creation_members SET phase = 'APPLYING' WHERE worktree_path = ?`, join(workspaceRoot, 'api-feat-halted'));
const resumedHalted = await create(['feat/halted', '--resume']);

// 4. APPLYING, and something that is not a worktree sits at the path: refused, nothing deleted.
const leftover = await create(['feat/leftover', '--repos', 'web,api,worker'], { featureCreateApply: failFor(last) });
const leftoverPath = join(workspaceRoot, `${last}-feat-leftover`);
sql(`UPDATE feature_creation_members SET phase = 'APPLYING' WHERE worktree_path = ?`, leftoverPath);
await mkdir(leftoverPath, { recursive: true });
await writeFile(join(leftoverPath, 'keep.txt'), 'mine\n');
const resumedLeftover = await create(['feat/leftover', '--resume']);

// 5. Nothing written anywhere: a new create with a different member set replaces it.
const nothing = await create(['feat/super', '--repos', 'web,api,worker'], { featureCreateApply: alwaysFail });
const superseding = await create(['feat/super', '--repos', 'web,api']);
const superStates = (query(`SELECT c.state FROM feature_creations c JOIN features f ON f.id = c.feature_id
  WHERE f.branch = 'refs/heads/feat/super' ORDER BY c.created_at`) as Array<{ state: string }>).map(({ state }) => state);

// 6. --resume guards.
const mismatchSetup = await create(['feat/mismatch', '--repos', 'web,api'], { featureCreateApply: failFor('api') });
const mismatch = await create(['feat/mismatch', '--resume', '--repos', 'web']);
const fromWithResume = await create(['feat/mismatch', '--resume', '--from', 'main']);

// 7. A live lease on one member refuses the creation before anything is written.
const web = (query('SELECT id FROM repositories WHERE main_root = ?', join(workspaceRoot, 'web')) as Array<{ id: string }>)[0]!.id;
sql(`INSERT INTO repository_operation_leases (repository_id, operation, token, pid, process_start_time, subject_worktree_id,
  stage, acquired_at, renewed_at, expires_at, host_id) VALUES (?, 'gc', 'held', 999999, 'x', NULL, NULL,
  '2026-09-13T00:00:00.000Z', '2026-09-13T00:00:00.000Z', '2999-01-01T00:00:00.000Z', 'elsewhere')`, web);
const busy = await create(['feat/busy', '--repos', 'web,api']);
const busyOnDisk = onDisk('feat/busy');
sql(`DELETE FROM repository_operation_leases WHERE token = 'held'`);

// 9. Registration fails for one member after Git succeeded: it stays APPLIED, and --resume only
// registers it, without a second `git worktree add`.
const isRepo = (repoPath: string, name: string) => repoPath.endsWith(`/${name}`) || repoPath.endsWith(`\\${name}`);
const unregistered = await create(['feat/unregistered', '--repos', 'web,api,worker'], {
  featureCreateRegistrationTopology: async (repoPath) => {
    if (isRepo(repoPath, last)) throw new Error('injected registration failure');
    return await listGitWorktrees(repoPath);
  },
});
let resumeApplies = 0;
const resumedUnregistered = await create(['feat/unregistered', '--resume'], {
  featureCreateApply: async (repoPath, plan) => { resumeApplies += 1; return await createWorktree(repoPath, plan); },
});

// 10. Git reports a HEAD other than the pinned start: the member stays APPLYING (its worktree
// exists), and --resume recognises the worktree on the branch and marks it applied.
const wrongHead = await create(['feat/wrong-head', '--repos', 'web,api,worker'], {
  featureCreateApply: async (repoPath, plan) => {
    const record = await createWorktree(repoPath, plan);
    return isRepo(repoPath, last) ? { ...record, worktree: { ...record.worktree, head: '0'.repeat(40) } } : record;
  },
});
const wrongHeadOnDisk = exists(last, 'feat/wrong-head');
const resumedWrongHead = await create(['feat/wrong-head', '--resume']);

// 11. A process died holding a `create` lease before it journalled anything: a fresh create is
// refused with a runnable remediation, running it clears the dead lease, and create then works.
// The PID of a child that has already exited: a real, valid PID with no process behind it, so the
// holder reads as gone on every platform (macOS `ps` rejects a PID above its range as an error, not
// as an absent process, and the lease rightly refuses to guess from that).
const exited = spawn(process.execPath, ['-e', '']);
await once(exited, 'exit');
const deadPid = exited.pid!;
sql(`INSERT INTO repository_operation_leases (repository_id, operation, token, pid, process_start_time, subject_worktree_id,
  stage, acquired_at, renewed_at, expires_at, host_id) VALUES (?, 'create', 'dead', ?, 'x', NULL, NULL,
  '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:02:00.000Z', ?)`, web, deadPid, hostname());
const staleRefused = await create(['feat/stale', '--repos', 'web,api']);
const staleArgv: string[] = staleRefused.envelope.errors[0]?.remediation?.[0]?.argv ?? [];
const staleCleared = await invoke([...staleArgv.slice(1), '--json']);
const staleLeaseRows = (query('SELECT COUNT(*) AS n FROM repository_operation_leases') as Array<{ n: number }>)[0]!.n;
const staleCreated = await create(['feat/stale', '--repos', 'web,api']);

// 12. The second pre-flight: a path filled between planning and holding the leases is refused, and
// nothing is journalled or written.
const raced = await create(['feat/raced', '--repos', 'web,api,worker'], {
  featureCreateAfterLeases: async () => { await mkdir(join(workspaceRoot, 'worker-feat-raced'), { recursive: true }); },
});
const count = (statement: string, ...parameters: unknown[]) => (query(statement, ...parameters) as Array<{ n: number }>)[0]!.n;
const branchIn = (repo: string, branch: string) => {
  try { git(join(workspaceRoot, repo), 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`); return true; } catch { return false; }
};

// 13. The open creation changed under the leases (a creation over another member set, which takes
// other leases, opened one): refused, nothing written by this run.
const changedUnder = await create(['feat/changed', '--repos', 'web,api'], {
  featureCreateAfterLeases: async () => { await create(['feat/changed', '--repos', 'worker'], { featureCreateApply: alwaysFail }); },
});

// 15. A REGISTERED member (nothing left to do) is not leased on --resume: an unrelated live
// gc/remove lease on its own repository -- one this resume was never going to touch -- must not
// block finishing the member that still has work. Runs before section 8, which deletes a
// repository row and forbids anything running after it.
const registeredBusySetup = await create(['feat/registered-busy', '--repos', 'web,api,worker'], { featureCreateApply: failFor(last) });
sql(
  `UPDATE feature_creation_members SET phase = 'REGISTERED' WHERE worktree_path = ?`,
  join(workspaceRoot, `${others[0]}-feat-registered-busy`),
);
const registeredBusyRepoId = (query('SELECT id FROM repositories WHERE main_root = ?', join(workspaceRoot, others[0]!)) as Array<{ id: string }>)[0]!.id;
sql(`INSERT INTO repository_operation_leases (repository_id, operation, token, pid, process_start_time, subject_worktree_id,
  stage, acquired_at, renewed_at, expires_at, host_id) VALUES (?, 'gc', 'registered-held', 999999, 'x', NULL, NULL,
  '2026-09-13T00:00:00.000Z', '2026-09-13T00:00:00.000Z', '2999-01-01T00:00:00.000Z', 'elsewhere')`, registeredBusyRepoId);
const resumedRegisteredBusy = await create(['feat/registered-busy', '--resume']);
sql(`DELETE FROM repository_operation_leases WHERE token = 'registered-held'`);

// 8. A resume treats a forgotten repository specially: a member with no work left (REGISTERED) is
// skipped even though its repository is gone; a member with work left whose repository is gone is
// refused by name. These delete a repository row, so nothing may run after them.
const forgotDoneSetup = await create(['feat/forgot-done', '--repos', 'web,api,worker'], { featureCreateApply: failFor(last) });
const forgotLeftSetup = await create(['feat/forgot-left', '--repos', 'web,api,worker'], { featureCreateApply: failFor(last) });
sql(
  `UPDATE feature_creation_members SET phase = 'REGISTERED' WHERE worktree_path IN (?, ?)`,
  join(workspaceRoot, `${others[0]}-feat-forgot-done`),
  join(workspaceRoot, `${others[1]}-feat-forgot-done`),
);
{
  const database = new Database(databasePath);
  database.pragma('foreign_keys = ON');
  database.prepare('DELETE FROM repositories WHERE main_root = ?').run(join(workspaceRoot, others[0]!));
  database.close();
}
const forgotDone = await create(['feat/forgot-done', '--resume']);
const forgotLeft = await create(['feat/forgot-left', '--resume']);

// 16. A fresh `--repos` create: a repository forgotten between the snapshot at the top of the
// command and the initial lease request (an adversarial concurrent `wtm forget`, not anything this
// run did) is reported the same clean way as a name --repos never resolved, not as a raw Git
// failure. Runs after section 8's own permanent deletion, so only `last` is still registered here.
const raceCreateRepoId = (query('SELECT id FROM repositories WHERE main_root = ?', join(workspaceRoot, last)) as Array<{ id: string }>)[0]!.id;
const raceCreated = await create(['feat/race-fresh', '--repos', last], {
  featureCreateBeforeLease: async () => {
    const database = new Database(databasePath);
    database.pragma('foreign_keys = ON');
    database.prepare('DELETE FROM repositories WHERE id = ?').run(raceCreateRepoId);
    database.close();
  },
});
const raceCreatedOnDisk = exists(last, 'feat/race-fresh');

// 17. `--resume`: the same race, this time between the snapshot and --resume's own lease request
// for a member with work left. Only `others[1]` is still registered at this point.
const raceResumeSetup = await create(['feat/race-resume', '--repos', others[1]!], { featureCreateApply: alwaysFail });
const raceResumeRepoId = (query('SELECT id FROM repositories WHERE main_root = ?', join(workspaceRoot, others[1]!)) as Array<{ id: string }>)[0]!.id;
const raceResumed = await create(['feat/race-resume', '--resume'], {
  featureCreateBeforeLease: async () => {
    const database = new Database(databasePath);
    database.pragma('foreign_keys = ON');
    database.prepare('DELETE FROM repositories WHERE id = ?').run(raceResumeRepoId);
    database.close();
  },
});
const raceResumedOnDisk = exists(others[1]!, 'feat/race-resume');

process.stdout.write(JSON.stringify({
  partial: {
    ok: partial.envelope.ok,
    code: partial.envelope.errors[0]?.code ?? null,
    remediation: partial.envelope.errors[0]?.remediation ?? null,
    failedOnDisk: partialFailedOnDisk,
    othersOnDisk: partialOthersOnDisk,
    failedPhase: phases(partial.envelope)[last],
    otherPhases: others.map((repo) => phases(partial.envelope)[repo]),
  },
  plainWhileOpen: { code: plainWhileOpen.envelope.errors[0]?.code ?? null },
  resumedPartial: {
    ok: resumedPartial.envelope.ok,
    resumed: resumedPartial.envelope.data?.resumed ?? null,
    failedRecoveredFrom: recoveredFrom(resumedPartial.envelope)[last],
    otherRecoveredFrom: others.map((repo) => recoveredFrom(resumedPartial.envelope)[repo]),
    phases: Object.values(phases(resumedPartial.envelope)),
    onDisk: onDisk('feat/partial'),
  },
  crashed: { ok: crashed.envelope.ok, apiPhase: crashedPhaseApi },
  resumedCrashed: { ok: resumedCrashed.envelope.ok, recoveredFrom: recoveredFrom(resumedCrashed.envelope), onDisk: onDisk('feat/crashed') },
  resumedHalted: { ok: halted.envelope.ok === false && resumedHalted.envelope.ok, apiRecoveredFrom: recoveredFrom(resumedHalted.envelope)['api'], onDisk: onDisk('feat/halted') },
  resumedLeftover: {
    ok: leftover.envelope.ok === false && resumedLeftover.envelope.ok,
    code: resumedLeftover.envelope.errors[0]?.code ?? null,
    keptFile: existsSync(join(leftoverPath, 'keep.txt')),
    othersStillThere: others.map((repo) => exists(repo, 'feat/leftover')),
  },
  superseded: { firstOk: nothing.envelope.ok, secondOk: superseding.envelope.ok, states: superStates, members: (superseding.envelope.data?.members ?? []).length },
  guards: { setupOk: mismatchSetup.envelope.ok, mismatch: mismatch.envelope.errors[0]?.code ?? null, fromWithResume: fromWithResume.envelope.errors[0]?.code ?? null },
  busy: { code: busy.envelope.errors[0]?.code ?? null, onDisk: busyOnDisk },
  unregistered: {
    ok: unregistered.envelope.ok,
    code: unregistered.envelope.errors[0]?.code ?? null,
    failedPhase: phases(unregistered.envelope)[last],
    otherPhases: others.map((repo) => phases(unregistered.envelope)[repo]),
    warningPaths: (unregistered.envelope.warnings[0]?.context?.paths ?? []).map((path: string) => path.split(/[\\/]/).pop()).sort(),
  },
  resumedUnregistered: {
    ok: resumedUnregistered.envelope.ok,
    applies: resumeApplies,
    failedRecoveredFrom: recoveredFrom(resumedUnregistered.envelope)[last],
    otherRecoveredFrom: others.map((repo) => recoveredFrom(resumedUnregistered.envelope)[repo]),
    warningPaths: (resumedUnregistered.envelope.warnings[0]?.context?.paths ?? []).map((path: string) => path.split(/[\\/]/).pop()),
  },
  wrongHead: {
    ok: wrongHead.envelope.ok,
    code: wrongHead.envelope.errors[0]?.code ?? null,
    failedPhase: phases(wrongHead.envelope)[last],
    onDisk: wrongHeadOnDisk,
  },
  resumedWrongHead: {
    ok: resumedWrongHead.envelope.ok,
    failedRecoveredFrom: recoveredFrom(resumedWrongHead.envelope)[last],
    phases: Object.values(phases(resumedWrongHead.envelope)),
  },
  staleLease: {
    refusedCode: staleRefused.envelope.errors[0]?.code ?? null,
    remediation: staleArgv,
    clearedCode: staleCleared.envelope.errors[0]?.code ?? null,
    clearedLeases: staleCleared.envelope.errors[0]?.context?.clearedLeases ?? null,
    leaseRowsAfterClear: staleLeaseRows,
    createdOk: staleCreated.envelope.ok,
  },
  raced: {
    ok: raced.envelope.ok,
    codes: raced.envelope.errors.map(({ code }) => code),
    data: raced.envelope.data,
    journalRows: count(`SELECT COUNT(*) AS n FROM features WHERE branch = 'refs/heads/feat/raced'`),
    leaseRows: count('SELECT COUNT(*) AS n FROM repository_operation_leases'),
    branches: ['web', 'api'].map((repo) => branchIn(repo, 'feat/raced')),
    worktrees: ['web', 'api'].map((repo) => exists(repo, 'feat/raced')),
  },
  changedUnder: {
    code: changedUnder.envelope.errors[0]?.code ?? null,
    data: changedUnder.envelope.data,
    worktrees: ['web', 'api'].map((repo) => exists(repo, 'feat/changed')),
    creations: count(`SELECT COUNT(*) AS n FROM feature_creations c JOIN features f ON f.id = c.feature_id WHERE f.branch = 'refs/heads/feat/changed'`),
  },
  forgotten: {
    doneOk: forgotDoneSetup.envelope.ok === false && forgotDone.envelope.ok,
    doneLastOnDisk: exists(last, 'feat/forgot-done'),
    leftOk: forgotLeft.envelope.ok,
    leftCode: forgotLeft.envelope.errors[0]?.code ?? null,
    leftNamesRepository: forgotLeft.envelope.errors[0]?.context?.repository === join(workspaceRoot, others[0]!),
    leftLastOnDisk: exists(last, 'feat/forgot-left'),
  },
  registeredBusy: {
    setupOk: registeredBusySetup.envelope.ok,
    ok: resumedRegisteredBusy.envelope.ok,
    code: resumedRegisteredBusy.envelope.errors[0]?.code ?? null,
    lastOnDisk: exists(last, 'feat/registered-busy'),
  },
  raceFresh: {
    ok: raceCreated.envelope.ok,
    code: raceCreated.envelope.errors[0]?.code ?? null,
    data: raceCreated.envelope.data,
    onDisk: raceCreatedOnDisk,
  },
  raceResume: {
    setupOk: raceResumeSetup.envelope.ok,
    ok: raceResumed.envelope.ok,
    code: raceResumed.envelope.errors[0]?.code ?? null,
    onDisk: raceResumedOnDisk,
  },
}));
