import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { appendFile, chmod, lstat, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AdapterMetadataResponse } from '@wtm/protocol';
import { createFakeAdapter, type FakeAdapter } from '../../../../testkit/src/fake-adapter';
import { developmentRuntimeInvocation } from '../../../../testkit/src/runtime-invocation';
import { createAdapterTrustStore, trustRepositoryAdapter } from '../adapter-trust';
import {
  invokeExternalAdapter as invokeAdapterDirectly,
  type ExternalAdapterCleanupState,
  type ExternalAdapterInvocation,
} from '../external-adapter';

const adapters: FakeAdapter[] = [];

function invokeExternalAdapter(input: ExternalAdapterInvocation): Promise<unknown> {
  return invokeAdapterDirectly({ runtimeInvocation: developmentRuntimeInvocation(), ...input });
}
const descriptorAuditScenarioPath = fileURLToPath(new URL('./descriptor-audit.scenario.ts', import.meta.url));

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.cleanup()));
});

describe('external adapter bridge', () => {
  test('does not execute a repository-local adapter before exact trust is recorded', async () => {
    const adapter = await fakeAdapter(metadataResponse());

    await expect(invokeExternalAdapter({
      adapterId: 'fake', executablePath: adapter.executablePath, repositoryRoot: adapter.root,
      operation: 'metadata', trust: createAdapterTrustStore(),
    })).rejects.toMatchObject({
      code: 'ADAPTER_NOT_TRUSTED',
      message: 'Repository-local external adapter is not trusted.',
    });
    expect(await adapter.runs()).toBe(0);
  });

  test('rejects a trusted adapter response with an incompatible protocol major', async () => {
    const adapter = await fakeAdapter({
      protocol: { major: 2, minor: 0 },
      adapter: { id: 'fake', name: 'Fake', version: '1.0.0', kind: 'custom', provides: [] },
    });
    const trust = createAdapterTrustStore();
    await trustRepositoryAdapter(trust, { adapterId: 'fake', executablePath: adapter.executablePath });

    await expect(invokeExternalAdapter({
      adapterId: 'fake', executablePath: adapter.executablePath, repositoryRoot: adapter.root,
      operation: 'metadata', trust,
    })).rejects.toMatchObject({
      code: 'ADAPTER_PROTOCOL_INCOMPATIBLE',
      message: 'External adapter protocol is incompatible.',
    });
  });

  test('rejects a trusted adapter response with an unsupported protocol minor', async () => {
    const adapter = await fakeAdapter({
      protocol: { major: 1, minor: 1 },
      adapter: { id: 'fake', name: 'Fake', version: '1.0.0', kind: 'custom', provides: [] },
    });
    const trust = createAdapterTrustStore();
    await trustRepositoryAdapter(trust, { adapterId: 'fake', executablePath: adapter.executablePath });

    await expect(invokeExternalAdapter({
      adapterId: 'fake', executablePath: adapter.executablePath, repositoryRoot: adapter.root,
      operation: 'metadata', trust,
    })).rejects.toMatchObject({
      code: 'ADAPTER_PROTOCOL_INCOMPATIBLE',
      message: 'External adapter protocol is incompatible.',
    });
  });

  test('returns a schema-validated response from an exactly trusted adapter', async () => {
    const adapter = await fakeAdapter(metadataResponse());
    const trust = await trusted(adapter);

    await expect(invokeExternalAdapter({
      adapterId: 'fake', executablePath: adapter.executablePath, repositoryRoot: adapter.root,
      operation: 'metadata', trust,
    })).resolves.toEqual(metadataResponse());
  });

  test('allows a trusted installed adapter outside the repository root', async () => {
    const adapter = await fakeAdapter(metadataResponse());
    const trust = await trusted(adapter);

    await expect(invokeExternalAdapter({
      adapterId: 'fake', executablePath: adapter.executablePath, repositoryRoot: join(adapter.root, 'repository'),
      operation: 'metadata', trust,
    })).resolves.toEqual(metadataResponse());
  });

  test('strictly validates a trusted non-metadata operation response', async () => {
    const adapter = await fakeAdapter({
      resources: [], actions: [], capabilities: {}, tasks: {}, unexpected: 'field',
    });
    const trust = await trusted(adapter);

    await expect(invokeExternalAdapter({
      adapterId: 'fake', executablePath: adapter.executablePath, repositoryRoot: adapter.root,
      operation: 'plan', trust,
      context: {
        workspace: { root: '/workspace' },
        repository: { root: '/repository', mainRoot: '/repository' },
        worktree: { root: '/worktree', id: 1, branch: 'feature' },
      },
    })).rejects.toMatchObject({
      code: 'ADAPTER_INVALID_RESPONSE',
      message: 'External adapter returned an invalid response.',
    });
  });

  test('rejects malformed stdout without leaking adapter output', async () => {
    const adapter = await createFakeAdapter({ type: 'malformed-json', output: '{"token":"super-secret"' });
    adapters.push(adapter);
    const trust = await trusted(adapter);

    await expect(invokeExternalAdapter({
      adapterId: 'fake', executablePath: adapter.executablePath, repositoryRoot: adapter.root,
      operation: 'metadata', trust,
    })).rejects.toMatchObject({
      code: 'ADAPTER_INVALID_RESPONSE',
      message: 'External adapter returned an invalid response.',
    });
    await expect(invokeExternalAdapter({
      adapterId: 'fake', executablePath: adapter.executablePath, repositoryRoot: adapter.root,
      operation: 'metadata', trust,
    })).rejects.not.toThrow('super-secret');
  });

  test('rejects invalid UTF-8 inside otherwise schema-shaped adapter JSON', async () => {
    const validPrefix = '{"protocol":{"major":1,"minor":0},"adapter":{"id":"fake","name":"F';
    const validSuffix = 'ake","version":"1.0.0","kind":"custom","provides":[]}}';
    const adapter = await createFakeAdapter({
      type: 'raw-stdout', bytes: [...Buffer.from(validPrefix), 0xff, ...Buffer.from(validSuffix)],
    });
    adapters.push(adapter);
    const trust = await trusted(adapter);

    await expect(invokeExternalAdapter({
      adapterId: 'fake', executablePath: adapter.executablePath, repositoryRoot: adapter.root,
      operation: 'metadata', trust,
    })).rejects.toMatchObject({
      code: 'ADAPTER_INVALID_RESPONSE',
      message: 'External adapter returned an invalid response.',
    });
  });

  test('terminates an adapter that exceeds its request timeout', async () => {
    const adapter = await createFakeAdapter({ type: 'timeout', delayMs: 500 });
    adapters.push(adapter);
    const trust = await trusted(adapter);

    await expect(invokeExternalAdapter({
      adapterId: 'fake', executablePath: adapter.executablePath, repositoryRoot: adapter.root,
      operation: 'metadata', trust, timeoutMs: 20,
      })).rejects.toMatchObject({
      code: 'ADAPTER_TIMEOUT',
      message: 'External adapter request timed out.',
    });
  });

  test('kills forked adapter descendants that retain inherited streams after timeout', async () => {
    const adapter = await createFakeAdapter({ type: 'fork-with-inherited-stdio', delayMs: 750 });
    adapters.push(adapter);
    const trust = await trusted(adapter);
    const pending = invokeExternalAdapter({
      adapterId: 'fake', executablePath: adapter.executablePath, repositoryRoot: adapter.root,
      operation: 'metadata', trust, timeoutMs: 500,
    });

    const result = await Promise.race([
      pending.then(
        () => ({ status: 'resolved' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      ),
      delay(750).then(() => ({ status: 'pending' as const })),
    ]);

    expect(result).toMatchObject({
      status: 'rejected',
      error: { code: 'ADAPTER_TIMEOUT', message: 'External adapter request timed out.' },
    });
    expect(await adapter.runs()).toBe(1);
    expect(await adapter.descendantSpawns()).toBe(1);
    await delay(350);
    expect(await adapter.descendantRuns()).toBe(0);
  });

  test('SIGKILLs a SIGTERM-ignoring descendant after its direct adapter parent closes', async () => {
    const adapter = await createFakeAdapter({ type: 'fork-ignoring-sigterm', delayMs: 250 });
    adapters.push(adapter);
    const trust = await trusted(adapter);

    await expect(invokeExternalAdapter({
      adapterId: 'fake', executablePath: adapter.executablePath, repositoryRoot: adapter.root,
      operation: 'metadata', trust, timeoutMs: 500,
    })).rejects.toMatchObject({
      code: 'ADAPTER_TIMEOUT',
      message: 'External adapter request timed out.',
    });
    expect(await adapter.runs()).toBe(1);
    expect(await adapter.descendantSpawns()).toBe(1);
    await delay(400);
    expect(await adapter.descendantRuns()).toBe(0);
  });

  test('settles and releases local pipe handles when a detached descendant inherits stdio', async () => {
    const adapter = await createFakeAdapter({ type: 'fork-detached-inherited-stdio', delayMs: 1_000 });
    adapters.push(adapter);
    const trust = await trusted(adapter);
    const baselinePipes = activePipeResources();
    let cleanup: ExternalAdapterCleanupState | undefined;

    await expect(invokeExternalAdapter({
      adapterId: 'fake', executablePath: adapter.executablePath, repositoryRoot: adapter.root,
      operation: 'metadata', trust, timeoutMs: 500,
      hooks: { afterTerminalCleanup: (state) => { cleanup = state; } },
    })).rejects.toMatchObject({ code: 'ADAPTER_TIMEOUT' });
    expect(await adapter.runs()).toBe(1);
    expect(await adapter.descendantSpawns()).toBe(1);
    await delay(25);
    expect(activePipeResources()).toBeLessThanOrEqual(baselinePipes);
    expect(cleanup).toEqual({
      stdinDestroyed: true,
      stdoutDestroyed: true,
      stderrDestroyed: true,
      stdoutDataListeners: 0,
      stderrDataListeners: 0,
      childCloseListeners: 0,
    });
  });

  test('bounds stdout and stderr before parsing a response', async () => {
    const stdoutAdapter = await createFakeAdapter({ type: 'oversized-stdout', bytes: 1_025 });
    const stderrAdapter = await createFakeAdapter({ type: 'oversized-stderr', bytes: 1_025 });
    adapters.push(stdoutAdapter, stderrAdapter);

    for (const adapter of [stdoutAdapter, stderrAdapter]) {
      const trust = await trusted(adapter);
      await expect(invokeExternalAdapter({
        adapterId: 'fake', executablePath: adapter.executablePath, repositoryRoot: adapter.root,
        operation: 'metadata', trust, maxOutputBytes: 1_024,
      })).rejects.toMatchObject({
        code: 'ADAPTER_INVALID_RESPONSE',
        message: 'External adapter returned an invalid response.',
      });
    }
  });

  test('invalidates trust when the adapter bytes change after trust', async () => {
    const adapter = await fakeAdapter(metadataResponse());
    const trust = await trusted(adapter);
    await appendFile(adapter.executablePath, '\n// changed adapter bytes\n');

    await expect(invokeExternalAdapter({
      adapterId: 'fake', executablePath: adapter.executablePath, repositoryRoot: adapter.root,
      operation: 'metadata', trust,
    })).rejects.toMatchObject({
      code: 'ADAPTER_NOT_TRUSTED',
      message: 'Repository-local external adapter is not trusted.',
    });
    expect(await adapter.runs()).toBe(0);
  });

  test('executes the verified descriptor bytes when the source path is replaced after verification', async () => {
    const adapter = await fakeAdapter(metadataResponse());
    const replacement = await createFakeAdapter({ type: 'malformed-json' });
    adapters.push(replacement);
    const trust = await trusted(adapter);

    await expect(invokeExternalAdapter({
      adapterId: 'fake', executablePath: adapter.executablePath, repositoryRoot: adapter.root,
      operation: 'metadata', trust,
      hooks: { async beforeSpawn() { await rename(replacement.executablePath, adapter.executablePath); } },
    })).resolves.toEqual(metadataResponse());
    expect(await adapter.runs()).toBe(1);
    expect(await replacement.runs()).toBe(0);
  });

  test('executes the verified bytes when the retained source inode is rewritten after verification', async () => {
    const verifiedResponse = metadataResponse();
    const mutatedResponse = {
      ...verifiedResponse,
      adapter: { ...verifiedResponse.adapter, name: 'Mutated after verification' },
    };
    const adapter = await fakeAdapter(verifiedResponse);
    const trust = await trusted(adapter);
    const before = await lstat(adapter.executablePath);
    let after: Awaited<ReturnType<typeof lstat>> | undefined;

    await expect(invokeExternalAdapter({
      adapterId: 'fake', executablePath: adapter.executablePath, repositoryRoot: adapter.root,
      operation: 'metadata', trust,
      hooks: {
        async afterVerification() {
          await adapter.setScenario({ type: 'response', response: mutatedResponse });
          after = await lstat(adapter.executablePath);
        },
      },
    })).resolves.toEqual(verifiedResponse);
    expect({ device: after?.dev, inode: after?.ino }).toEqual({ device: before.dev, inode: before.ino });
  });

  test('creates no snapshot artifacts while invoking an adapter', async () => {
    const attackerTmp = await mkdtemp(join(tmpdir(), 'wtm-attacker-tmp-'));

    try {
      const result = spawnSync('node', ['--import', 'tsx', descriptorAuditScenarioPath], {
        encoding: 'utf8', env: { ...process.env, TMPDIR: attackerTmp },
      });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({ afterVerificationRan: true, snapshotArtifactSeen: false, response: metadataResponse() });
    } finally {
      await rm(attackerTmp, { recursive: true, force: true });
    }
  });

  test('preserves the trusted executable basename for a supported self-contained script', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wtm-named-adapter-'));
    const executablePath = join(root, 'wtm-adapter-basename.mjs');
    const expected = 'wtm-adapter-basename.mjs';
    await writeFile(executablePath, [
      '#!/usr/bin/env node',
      '// wtm-adapter-v1: self-contained',
      "process.stdin.resume(); await new Promise((resolve) => process.stdin.on('end', resolve));",
      "process.stdout.write(JSON.stringify({ protocol: { major: 1, minor: 0 }, adapter: { id: 'fake', name: process.argv[1].split('/').at(-1), version: '1.0.0', kind: 'custom', provides: [] } }));",
      '',
    ].join('\n'), { mode: 0o700 });
    await chmod(executablePath, 0o700);
    const trust = createAdapterTrustStore();

    try {
      await trustRepositoryAdapter(trust, { adapterId: 'fake', executablePath });
      await expect(invokeExternalAdapter({
        adapterId: 'fake', executablePath, repositoryRoot: root,
        operation: 'metadata', trust,
      })).resolves.toMatchObject({ adapter: { name: expected } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('denies a semicolon-prefixed static filesystem import at execution time', async () => {
    const adapter = await declaredAdapter(";import './dependency.mjs';\n" + metadataProgram());
    await writeFile(join(adapter.root, 'dependency.mjs'), 'throw new Error("dependency executed");\n', { mode: 0o700 });
    const trust = await trustedScript(adapter);

    try {
      await expect(invokeExternalAdapter({
        adapterId: 'fake', executablePath: adapter.executablePath, repositoryRoot: adapter.root, operation: 'metadata', trust,
      })).rejects.toMatchObject({ code: 'ADAPTER_NOT_TRUSTED', message: 'External adapter module dependency is not permitted.' });
    } finally {
      await adapter.cleanup();
    }
  });

  test('denies a re-exported filesystem dependency at execution time', async () => {
    const adapter = await declaredAdapter("export * from './dependency.mjs';\n" + metadataProgram());
    await writeFile(join(adapter.root, 'dependency.mjs'), 'export const replacement = true;\n', { mode: 0o700 });
    const trust = await trustedScript(adapter);

    try {
      await expect(invokeExternalAdapter({
        adapterId: 'fake', executablePath: adapter.executablePath, repositoryRoot: adapter.root, operation: 'metadata', trust,
      })).rejects.toMatchObject({ code: 'ADAPTER_NOT_TRUSTED', message: 'External adapter module dependency is not permitted.' });
    } finally {
      await adapter.cleanup();
    }
  });

  test('defers a computed dynamic filesystem import to the execution guard', async () => {
    const adapter = await declaredAdapter("await import('./' + 'dependency.mjs');\n" + metadataProgram());
    await writeFile(join(adapter.root, 'dependency.mjs'), 'export const replacement = true;\n', { mode: 0o700 });

    try {
      const trust = await trustedScript(adapter);
      await expect(invokeExternalAdapter({
        adapterId: 'fake', executablePath: adapter.executablePath, repositoryRoot: adapter.root, operation: 'metadata', trust,
      })).rejects.toMatchObject({ code: 'ADAPTER_NOT_TRUSTED', message: 'External adapter module dependency is not permitted.' });
    } finally {
      await adapter.cleanup();
    }
  });

  test('defers createRequire filesystem resolution to the execution guard', async () => {
    const adapter = await declaredAdapter([
      "import { createRequire } from 'node:module';",
      'const require = createRequire(import.meta.url);',
      "require('./dependency.cjs');",
      metadataProgram(),
    ].join('\n'));
    await writeFile(join(adapter.root, 'dependency.cjs'), 'module.exports = { replacement: true };\n', { mode: 0o700 });

    try {
      const trust = await trustedScript(adapter);
      await expect(invokeExternalAdapter({
        adapterId: 'fake', executablePath: adapter.executablePath, repositoryRoot: adapter.root, operation: 'metadata', trust,
      })).rejects.toMatchObject({ code: 'ADAPTER_NOT_TRUSTED', message: 'External adapter module dependency is not permitted.' });
    } finally {
      await adapter.cleanup();
    }
  });

  test('denies a later node:module hook that short-circuits the dependency guard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wtm-hook-bypass-'));
    const dependencyPath = join(root, 'dependency.mjs');
    const dependencyUrl = pathToFileURL(dependencyPath).href;
    const escapedResponse = {
      ...metadataResponse(),
      adapter: { ...metadataResponse().adapter, name: 'Unsigned dependency' },
    };
    await writeFile(dependencyPath, `export const response = ${JSON.stringify(escapedResponse)};\n`, { mode: 0o700 });
    const adapter = await declaredAdapter([
      "import { registerHooks } from 'node:module';",
      `const dependencyUrl = ${JSON.stringify(dependencyUrl)};`,
      'registerHooks({',
      '  resolve(specifier, context, nextResolve) {',
      '    if (specifier === dependencyUrl) return { url: specifier, shortCircuit: true };',
      '    return nextResolve(specifier, context);',
      '  },',
      '});',
      'const { response } = await import(dependencyUrl);',
      metadataProgram('response'),
    ].join('\n'));

    try {
      const trust = await trustedScript(adapter);
      await expect(invokeExternalAdapter({
        adapterId: 'fake', executablePath: adapter.executablePath, repositoryRoot: adapter.root, operation: 'metadata', trust,
      })).rejects.toMatchObject({ code: 'ADAPTER_NOT_TRUSTED', message: 'External adapter module dependency is not permitted.' });
    } finally {
      await Promise.all([adapter.cleanup(), rm(root, { recursive: true, force: true })]);
    }
  });

  test('denies node:module through the global builtin loader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wtm-global-module-bypass-'));
    const dependencyPath = join(root, 'dependency.mjs');
    const dependencyUrl = pathToFileURL(dependencyPath).href;
    await writeFile(dependencyPath, `export const response = ${JSON.stringify(metadataResponse())};\n`, { mode: 0o700 });
    const adapter = await declaredAdapter([
      "const { registerHooks } = process.getBuiltinModule('module');",
      `const dependencyUrl = ${JSON.stringify(dependencyUrl)};`,
      'registerHooks({',
      '  resolve(specifier, context, nextResolve) {',
      '    if (specifier === dependencyUrl) return { url: specifier, shortCircuit: true };',
      '    return nextResolve(specifier, context);',
      '  },',
      '});',
      'const { response } = await import(dependencyUrl);',
      metadataProgram('response'),
    ].join('\n'));

    try {
      const trust = await trustedScript(adapter);
      await expect(invokeExternalAdapter({
        adapterId: 'fake', executablePath: adapter.executablePath, repositoryRoot: adapter.root, operation: 'metadata', trust,
      })).rejects.toMatchObject({ code: 'ADAPTER_NOT_TRUSTED', message: 'External adapter module dependency is not permitted.' });
    } finally {
      await Promise.all([adapter.cleanup(), rm(root, { recursive: true, force: true })]);
    }
  });

  test('denies registerHooks/createRequire through the eval-only global module accessor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wtm-eval-global-module-bypass-'));
    const dependencyPath = join(root, 'dependency.cjs');
    const dependencyUrl = pathToFileURL(dependencyPath).href;
    const escapedResponse = {
      ...metadataResponse(),
      adapter: { ...metadataResponse().adapter, name: 'Unsigned dependency' },
    };
    await writeFile(dependencyPath, `module.exports = { response: ${JSON.stringify(escapedResponse)} };\n`, { mode: 0o700 });
    const adapter = await declaredAdapter([
      'const { registerHooks, createRequire } = globalThis.module;',
      `const dependencyPath = ${JSON.stringify(dependencyPath)};`,
      `const dependencyUrl = ${JSON.stringify(dependencyUrl)};`,
      'registerHooks({',
      '  resolve(specifier, context, nextResolve) {',
      "    if (specifier === dependencyPath) return { url: dependencyUrl, format: 'commonjs', shortCircuit: true };",
      '    return nextResolve(specifier, context);',
      '  },',
      '});',
      'const require = createRequire(import.meta.url);',
      'const { response } = require(dependencyPath);',
      metadataProgram('response'),
    ].join('\n'));

    try {
      const trust = await trustedScript(adapter);
      await expect(invokeExternalAdapter({
        adapterId: 'fake', executablePath: adapter.executablePath, repositoryRoot: adapter.root, operation: 'metadata', trust,
      })).rejects.toMatchObject({ code: 'ADAPTER_NOT_TRUSTED', message: 'External adapter module dependency is not permitted.' });
    } finally {
      await Promise.all([adapter.cleanup(), rm(root, { recursive: true, force: true })]);
    }
  });

  test('denies an absolute dependency even when its bytes change after trust', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wtm-absolute-dependency-'));
    const dependencyPath = join(root, 'dependency.mjs');
    const adapter = await declaredAdapter(`;import { response } from ${JSON.stringify(dependencyPath)};\n${metadataProgram('response')}`);
    await writeFile(dependencyPath, `export const response = ${JSON.stringify(metadataResponse())};\n`, { mode: 0o700 });

    try {
      const trust = await trustedScript(adapter);
      await writeFile(dependencyPath, `export const response = ${JSON.stringify({ ...metadataResponse(), adapter: { ...metadataResponse().adapter, name: 'changed dependency' } })};\n`, { mode: 0o700 });
      await expect(invokeExternalAdapter({
        adapterId: 'fake', executablePath: adapter.executablePath, repositoryRoot: adapter.root, operation: 'metadata', trust,
      })).rejects.toMatchObject({ code: 'ADAPTER_NOT_TRUSTED', message: 'External adapter module dependency is not permitted.' });
    } finally {
      await Promise.all([adapter.cleanup(), rm(root, { recursive: true, force: true })]);
    }
  });

  test('closes the trusted descriptor after success, error, and timeout', async () => {
    const success = await fakeAdapter(metadataResponse());
    const malformed = await createFakeAdapter({ type: 'malformed-json' });
    const timeout = await createFakeAdapter({ type: 'timeout', delayMs: 500 });
    adapters.push(malformed, timeout);

    for (const [adapter, timeoutMs] of [[success, undefined], [malformed, undefined], [timeout, 20]] as const) {
      const trust = await trusted(adapter);
      let descriptorClosed = 0;
      const outcome = invokeExternalAdapter({
        adapterId: 'fake', executablePath: adapter.executablePath, repositoryRoot: adapter.root,
        operation: 'metadata', trust,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        hooks: { afterDescriptorClose: () => { descriptorClosed += 1; } },
      });
      if (adapter === success) await expect(outcome).resolves.toEqual(metadataResponse());
      else await expect(outcome).rejects.toBeDefined();
      expect(descriptorClosed).toBe(1);
    }
  });

  test('closes the trusted descriptor when the Node runtime cannot spawn', async () => {
    const adapter = await fakeAdapter(metadataResponse());
    const trust = await trusted(adapter);
    let descriptorClosed = 0;

    await expect(invokeExternalAdapter({
      adapterId: 'fake', executablePath: adapter.executablePath, repositoryRoot: adapter.root,
      operation: 'metadata', trust,
      hooks: {
        runtimeExecutable: join(adapter.root, 'missing-node-runtime'),
        afterDescriptorClose: () => { descriptorClosed += 1; },
      },
    })).rejects.toMatchObject({ code: 'ADAPTER_INVALID_RESPONSE' });
    expect(descriptorClosed).toBe(1);
  });
});

async function fakeAdapter(response: unknown): Promise<FakeAdapter> {
  const adapter = await createFakeAdapter({ type: 'response', response });
  adapters.push(adapter);
  return adapter;
}

async function trusted(adapter: FakeAdapter) {
  const trust = createAdapterTrustStore();
  await trustRepositoryAdapter(trust, { adapterId: 'fake', executablePath: adapter.executablePath });
  return trust;
}

interface DeclaredAdapter {
  root: string;
  executablePath: string;
  cleanup(): Promise<void>;
}

async function declaredAdapter(body: string, hashbang = '#!/usr/bin/env node'): Promise<DeclaredAdapter> {
  const root = await mkdtemp(join(tmpdir(), 'wtm-declared-adapter-'));
  const executablePath = join(root, 'wtm-adapter-declared.mjs');
  await writeFile(executablePath, [hashbang, '// wtm-adapter-v1: self-contained', body, ''].join('\n'), { mode: 0o700 });
  await chmod(executablePath, 0o700);
  return { root, executablePath, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function trustedScript(adapter: DeclaredAdapter) {
  const trust = createAdapterTrustStore();
  await trustRepositoryAdapter(trust, { adapterId: 'fake', executablePath: adapter.executablePath });
  return trust;
}

function metadataProgram(value = JSON.stringify(metadataResponse())): string {
  return [
    "process.stdin.resume(); await new Promise((resolve) => process.stdin.on('end', resolve));",
    `process.stdout.write(JSON.stringify(${value}));`,
  ].join('\n');
}

function metadataResponse(): AdapterMetadataResponse {
  return {
    protocol: { major: 1, minor: 0 },
    adapter: { id: 'fake', name: 'Fake', version: '1.0.0', kind: 'custom', provides: [] },
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function activePipeResources(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === 'PipeWrap').length;
}
