import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The release workflow's notarization step, run for real against a scripted `notarytool`.
 *
 * Increment G's design says the credential-absent path has to work without Apple credentials,
 * because a contributor with none must still be able to build a prerelease — the same way the
 * signing step is usable with no certificate. That claim is only worth something if something
 * checks it, and `release-workflow.test.ts` cannot: it reads the YAML's shape, not what the shell
 * inside it decides.
 *
 * So this executes the step's actual `run` block, extracted from `release.yml` rather than copied,
 * with `xcrun` and `spctl` replaced by shims that answer what each case says they answer. It
 * proves every branch of the decision — which credential shape is used, whether a submission is
 * attempted at all, and what verdict each outcome produces — without contacting Apple.
 *
 * `spctl` refusing after the notary service accepted is the case worth naming: a ticket Apple
 * issued that Gatekeeper will not honour is not a notarized release, and reporting `notarized` on
 * the strength of the submission alone would put the defect item 36 documents back into a stable
 * release with nothing left to catch it.
 */
const root = fileURLToPath(new URL('../..', import.meta.url));
const temporaries: string[] = [];

afterEach(() => {
  while (temporaries.length > 0) rmSync(temporaries.pop() as string, { recursive: true, force: true });
});

interface WorkflowStep {
  id?: string;
  run?: string;
  env?: Record<string, string>;
}

function notarizeStep(): Required<Pick<WorkflowStep, 'run'>> & WorkflowStep {
  const workflow = Bun.YAML.parse(readFileSync(join(root, '.github/workflows/release.yml'), 'utf8')) as {
    jobs?: Record<string, { steps?: WorkflowStep[] }>;
  };
  const step = (workflow.jobs?.['verify']?.steps ?? []).find(({ id }) => id === 'notarize');
  if (step?.run === undefined) throw new Error('release.yml has no verify-job step with id "notarize"');
  return { ...step, run: step.run };
}

interface Outcome {
  /** What the step wrote to `$GITHUB_OUTPUT`, which is the only thing the gate ever reads. */
  notarization: string;
  /** The arguments `notarytool` was called with, or null when it was never called. */
  xcrun: string | null;
  /** Whatever the step left in `$RUNNER_TEMP`, so a leaked credential is visible. */
  runnerTemp: string[];
  transcript: string;
}

/** Runs the step's real shell with scripted `xcrun`/`spctl`, and reports what it decided. */
function runStep(environment: Readonly<Record<string, string>>): Outcome {
  const directory = mkdtempSync(join(tmpdir(), 'wtm-notarize-step-'));
  temporaries.push(directory);
  const bin = join(directory, 'bin');
  const runnerTemp = join(directory, 'runner-temp');
  mkdirSync(bin, { recursive: true });
  mkdirSync(runnerTemp, { recursive: true });
  mkdirSync(join(directory, 'dist/sea'), { recursive: true });
  // `ditto` is the real one, so the submission archive is really built from a real file; only the
  // two commands that would reach Apple or the local assessment policy are replaced.
  writeFileSync(join(directory, 'dist/sea/wtm'), 'stands in for the standalone executable');
  writeFileSync(join(directory, 'step.sh'), notarizeStep().run);
  writeFileSync(join(bin, 'xcrun'), '#!/bin/bash\necho "$*" > "$SHIM_LOG"\nprintf \'%s\' "$FAKE_NOTARY_JSON"\nexit "$FAKE_NOTARY_EXIT"\n');
  writeFileSync(join(bin, 'spctl'), '#!/bin/bash\nexit "$FAKE_SPCTL_EXIT"\n');
  chmodSync(join(bin, 'xcrun'), 0o755);
  chmodSync(join(bin, 'spctl'), 0o755);

  const outputPath = join(directory, 'github-output');
  const shimLog = join(directory, 'xcrun-arguments');
  writeFileSync(outputPath, '');
  const result = spawnSync('/bin/bash', [join(directory, 'step.sh')], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      // `bun` is on PATH because the step parses notarytool's JSON with it.
      PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin'].join(':'),
      RUNNER_TEMP: runnerTemp,
      GITHUB_OUTPUT: outputPath,
      SHIM_LOG: shimLog,
      FAKE_NOTARY_JSON: '',
      FAKE_NOTARY_EXIT: '0',
      FAKE_SPCTL_EXIT: '0',
      SIGNING: 'signed',
      NOTARY_API_KEY: '',
      NOTARY_API_KEY_ID: '',
      NOTARY_API_ISSUER: '',
      NOTARY_APPLE_ID: '',
      NOTARY_PASSWORD: '',
      NOTARY_TEAM_ID: '',
      ...environment,
    },
  });
  const transcript = `${result.stdout}${result.stderr}`;
  expect(result.status, transcript).toBe(0);
  return {
    notarization: readFileSync(outputPath, 'utf8').trim().replace(/^notarization=/, ''),
    xcrun: existsSync(shimLog) ? readFileSync(shimLog, 'utf8').trim() : null,
    runnerTemp: readdirSync(runnerTemp).sort(),
    transcript,
  };
}

const apiKey = Buffer.from('-----BEGIN PRIVATE KEY-----\nnot a real key\n').toString('base64');

// The step shells out to `/bin/bash`, `ditto` and `base64`, and the job it belongs to only ever
// runs on a macOS runner, so there is nothing here to assert on another platform.
describe.skipIf(process.platform !== 'darwin')('release notarization step', () => {
  test('takes every secret through the step env, never interpolated into the script body', () => {
    const step = notarizeStep();

    // A `${{ secrets.* }}` written into the body instead would be substituted before bash ever saw
    // it, putting the secret in the runner's process listing and in any `set -x` transcript.
    expect(step.run).not.toContain('${{');
    expect(Object.keys(step.env ?? {}).sort()).toEqual([
      'NOTARY_API_ISSUER', 'NOTARY_API_KEY', 'NOTARY_API_KEY_ID',
      'NOTARY_APPLE_ID', 'NOTARY_PASSWORD', 'NOTARY_TEAM_ID', 'SIGNING',
    ]);
  });

  test('skips notarization when no Apple credentials are configured', () => {
    const outcome = runStep({ SIGNING: 'signed' });

    // Nothing submitted, nothing failed: a contributor with no Apple account still builds.
    expect(outcome.notarization).toBe('skipped');
    expect(outcome.xcrun).toBeNull();
  });

  test('skips notarization for an ad-hoc signature even when credentials are configured', () => {
    // An ad-hoc signature is not a Developer ID signature, and the notary service refuses one
    // outright — submitting it would spend several minutes reaching an answer already known here.
    const outcome = runStep({ SIGNING: 'adhoc', NOTARY_API_KEY: apiKey, NOTARY_API_KEY_ID: 'ABCDE12345' });

    expect(outcome.notarization).toBe('skipped');
    expect(outcome.xcrun).toBeNull();
  });

  test('submits with an App Store Connect key, passing --issuer only when one is configured', () => {
    const withIssuer = runStep({
      NOTARY_API_KEY: apiKey,
      NOTARY_API_KEY_ID: 'ABCDE12345',
      NOTARY_API_ISSUER: '11111111-2222-3333-4444-555555555555',
      FAKE_NOTARY_JSON: '{"id":"submission-1","status":"Accepted"}',
    });

    expect(withIssuer.notarization).toBe('notarized');
    expect(withIssuer.xcrun).toContain('--key-id ABCDE12345');
    expect(withIssuer.xcrun).toContain('--issuer 11111111-2222-3333-4444-555555555555');
    expect(withIssuer.xcrun).toContain('--wait');

    // `notarytool submit --help`: the issuer is required for a team key and must be omitted for an
    // individual one, so an unset secret must not become an empty `--issuer` argument.
    const withoutIssuer = runStep({
      NOTARY_API_KEY: apiKey,
      NOTARY_API_KEY_ID: 'ABCDE12345',
      FAKE_NOTARY_JSON: '{"id":"submission-1","status":"Accepted"}',
    });

    expect(withoutIssuer.notarization).toBe('notarized');
    expect(withoutIssuer.xcrun).not.toContain('--issuer');
  });

  test('submits with an Apple ID, app-specific password and team ID', () => {
    const outcome = runStep({
      NOTARY_APPLE_ID: 'releases@example.com',
      NOTARY_PASSWORD: 'abcd-efgh-ijkl-mnop',
      NOTARY_TEAM_ID: 'TEAMID1234',
      FAKE_NOTARY_JSON: '{"id":"submission-2","status":"Accepted"}',
    });

    expect(outcome.notarization).toBe('notarized');
    expect(outcome.xcrun).toContain('--apple-id releases@example.com');
    expect(outcome.xcrun).toContain('--team-id TEAMID1234');
    expect(outcome.xcrun).not.toContain('--key-id');
  });

  test('reports rejected when the notary service turns the submission down', () => {
    const invalid = runStep({
      NOTARY_API_KEY: apiKey,
      NOTARY_API_KEY_ID: 'ABCDE12345',
      FAKE_NOTARY_JSON: '{"id":"submission-3","status":"Invalid"}',
    });

    expect(invalid.notarization).toBe('rejected');

    const failed = runStep({
      NOTARY_API_KEY: apiKey,
      NOTARY_API_KEY_ID: 'ABCDE12345',
      FAKE_NOTARY_JSON: '',
      FAKE_NOTARY_EXIT: '1',
    });

    expect(failed.notarization).toBe('rejected');
  });

  test('reports rejected when Gatekeeper refuses what the notary service accepted', () => {
    const outcome = runStep({
      NOTARY_API_KEY: apiKey,
      NOTARY_API_KEY_ID: 'ABCDE12345',
      FAKE_NOTARY_JSON: '{"id":"submission-4","status":"Accepted"}',
      FAKE_SPCTL_EXIT: '3',
    });

    expect(outcome.notarization).toBe('rejected');
  });

  test('leaves no decoded private key behind after submitting', () => {
    const outcome = runStep({
      NOTARY_API_KEY: apiKey,
      NOTARY_API_KEY_ID: 'ABCDE12345',
      FAKE_NOTARY_JSON: '{"id":"submission-5","status":"Accepted"}',
    });

    expect(outcome.notarization).toBe('notarized');
    // The runner temp directory outlives this step and is readable by every later step in the job.
    expect(outcome.runnerTemp.filter((name) => name.endsWith('.p8'))).toEqual([]);
    expect(outcome.transcript).not.toContain('BEGIN PRIVATE KEY');
  });
});
