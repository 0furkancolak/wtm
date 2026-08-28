import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type FakeAdapterScenario =
  | { type: 'response'; response: unknown }
  | { type: 'malformed-json'; output?: string }
  | { type: 'raw-stdout'; bytes: readonly number[] }
  | { type: 'timeout'; delayMs: number }
  | { type: 'fork-with-inherited-stdio'; delayMs: number }
  | { type: 'fork-ignoring-sigterm'; delayMs: number }
  | { type: 'fork-detached-inherited-stdio'; delayMs: number }
  | { type: 'oversized-stdout'; bytes: number }
  | { type: 'oversized-stderr'; bytes: number };

export interface FakeAdapter {
  readonly root: string;
  readonly executablePath: string;
  setScenario(scenario: FakeAdapterScenario): Promise<void>;
  runs(): Promise<number>;
  descendantSpawns(): Promise<number>;
  descendantRuns(): Promise<number>;
  cleanup(): Promise<void>;
}

const program = String.raw`#!/usr/bin/env node
// wtm-adapter-v1: self-contained
import { spawn } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = __ROOT__;
const scenario = __SCENARIO__;
await appendFile(join(root, 'runs.log'), 'run\n');
process.stdin.resume();
await new Promise((resolve) => process.stdin.on('end', resolve));
if (scenario.type === 'timeout') {
  await new Promise((resolve) => setTimeout(resolve, scenario.delayMs));
  process.exit(0);
}
if (scenario.type === 'fork-with-inherited-stdio') {
  const descendant = spawn(process.execPath, [
    '-e', 'const { appendFile } = require("node:fs/promises"); setTimeout(() => appendFile(process.argv[1], "run\\n"), Number(process.argv[2]))',
    join(root, 'descendant-runs.log'), String(scenario.delayMs),
  ], { stdio: 'inherit' });
  descendant.unref();
  await appendFile(join(root, 'descendant-spawns.log'), 'spawn\n');
  process.exit(0);
}
if (scenario.type === 'fork-ignoring-sigterm') {
  const descendant = spawn(process.execPath, [
    '-e', 'const { appendFile } = require("node:fs/promises"); process.on("SIGTERM", () => setTimeout(() => appendFile(process.argv[1], "run\\n"), Number(process.argv[2]))); setTimeout(() => process.exit(0), Number(process.argv[2]) + 1_000)',
    join(root, 'descendant-runs.log'), String(scenario.delayMs),
  ], { stdio: 'ignore' });
  descendant.unref();
  await appendFile(join(root, 'descendant-spawns.log'), 'spawn\n');
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
}
if (scenario.type === 'fork-detached-inherited-stdio') {
  const descendant = spawn(process.execPath, [
    '-e', 'setTimeout(() => process.exit(0), Number(process.argv[1]))', String(scenario.delayMs),
  ], { detached: true, stdio: 'inherit' });
  descendant.unref();
  await appendFile(join(root, 'descendant-spawns.log'), 'spawn\n');
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
}
if (scenario.type === 'malformed-json') {
  process.stdout.write(scenario.output ?? '{not-json');
  process.exit(0);
}
if (scenario.type === 'raw-stdout') {
  process.stdout.write(Buffer.from(scenario.bytes));
  process.exit(0);
}
if (scenario.type === 'oversized-stdout') {
  process.stdout.write('x'.repeat(scenario.bytes));
  process.exit(0);
}
if (scenario.type === 'oversized-stderr') {
  process.stderr.write('x'.repeat(scenario.bytes));
  process.exit(0);
}
process.stdout.write(JSON.stringify(scenario.response));
`;

function programFor(root: string, scenario: FakeAdapterScenario): string {
  return program.replace('__ROOT__', JSON.stringify(root)).replace('__SCENARIO__', JSON.stringify(scenario));
}

export async function createFakeAdapter(initial: FakeAdapterScenario): Promise<FakeAdapter> {
  const root = await mkdtemp(join(tmpdir(), 'wtm-fake-adapter-'));
  const executablePath = join(root, 'wtm-adapter-fake.mjs');
  const runsPath = join(root, 'runs.log');
  await writeFile(executablePath, programFor(root, initial), { mode: 0o700 });
  await chmod(executablePath, 0o700);

  return {
    root,
    executablePath,
    async setScenario(scenario) {
      await writeFile(executablePath, programFor(root, scenario), { mode: 0o700 });
      await chmod(executablePath, 0o700);
    },
    async runs() {
      return (await readFile(runsPath, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
    },
    async descendantSpawns() {
      return (await readFile(join(root, 'descendant-spawns.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
    },
    async descendantRuns() {
      return (await readFile(join(root, 'descendant-runs.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
    },
    cleanup: async () => rm(root, { recursive: true, force: true }),
  };
}
