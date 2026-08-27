import { describe, expect, it } from 'bun:test';
import * as adapterProtocol from '../adapter';
import type { AdapterPlan } from '../adapter';
import {
  adapterMetadataResponseSchema,
  adapterPlanResponseSchema,
  adapterCleanupPlanResponseSchema,
  adapterDoctorResponseSchema,
  adapterRequestSchema,
  adapterResponseSchema,
  isProtocolVersionCompatible,
  parseAdapterResponse,
  protocolVersionSchema,
} from '../adapter';

describe('adapter protocol schemas', () => {
  it('exports one schema-backed API for built-in adapter values', () => {
    expect(adapterProtocol).toHaveProperty('adapterMetadataSchema');
    expect(adapterProtocol).toHaveProperty('adapterContextSchema');
    expect(adapterProtocol).toHaveProperty('detectionResultSchema');
    expect(adapterProtocol).toHaveProperty('adapterPlanSchema');
    expect(adapterProtocol).toHaveProperty('doctorCheckSchema');
  });

  it('accepts a versioned metadata request', () => {
    expect(
      adapterRequestSchema.parse({
        protocol: { major: 1, minor: 0 },
        operation: 'metadata',
      }),
    ).toEqual({ protocol: { major: 1, minor: 0 }, operation: 'metadata' });
  });

  it('requires topology context for detection', () => {
    expect(() =>
      adapterRequestSchema.parse({
        protocol: { major: 1, minor: 0 },
        operation: 'detect',
      }),
    ).toThrow();
  });

  it('rejects incompatible protocol majors', () => {
    expect(() => protocolVersionSchema.parse({ major: 2, minor: 0 })).toThrow();
  });

  it('requires an exact minor until a schema opts into forward compatibility', () => {
    expect(isProtocolVersionCompatible(protocolVersionSchema.parse({ major: 1, minor: 1 }))).toBe(false);
  });

  it('rejects unknown request keys', () => {
    expect(() =>
      adapterRequestSchema.parse({
        protocol: { major: 1, minor: 0 },
        operation: 'metadata',
        unexpected: true,
      }),
    ).toThrow();
  });

  it('accepts the documented metadata response without an operation', () => {
    expect(
      adapterMetadataResponseSchema.parse({
        protocol: { major: 1, minor: 0 },
        adapter: {
          id: 'cargo',
          name: 'Cargo',
          version: '1.0.0',
          kind: 'package-manager',
          provides: ['rust.package-manager', 'rust.build-system', 'deps.install'],
        },
      }),
    ).toMatchObject({ adapter: { id: 'cargo' } });
  });

  it('models adapter graph dependencies as required capabilities', () => {
    expect(
      adapterProtocol.adapterMetadataSchema.parse({
        id: 'next',
        name: 'Next.js',
        version: '1.0.0',
        kind: 'framework',
        provides: ['javascript.framework'],
        requires: ['javascript.package-manager'],
      }),
    ).toMatchObject({ requires: ['javascript.package-manager'] });
  });

  it('accepts the documented detection output without transport fields', () => {
    expect(
      adapterResponseSchema.parse({
        detected: true,
        confidence: 1,
        evidence: [{ kind: 'file', value: 'Cargo.toml' }],
      }),
    ).toMatchObject({ detected: true });
  });

  it('rejects a malformed plan action', () => {
    expect(() =>
      adapterPlanResponseSchema.parse({
        resources: [],
        actions: [{ type: 'exec', argv: [] }],
        capabilities: {},
        tasks: {},
      }),
    ).toThrow();
  });

  it('rejects adapter resources with an unknown policy before use', () => {
    expect(() =>
      adapterPlanResponseSchema.parse({
        resources: [{ name: 'deps', type: 'dependency-view', path: 'node_modules', policy: 'unsafe-share', retention: 'ephemeral' }],
        actions: [],
        capabilities: {},
        tasks: {},
      }),
    ).toThrow();
  });

  it('accepts controlled argv and explicit-shell task contributions', () => {
    const plan = adapterPlanResponseSchema.parse({
      resources: [],
      actions: [],
      capabilities: {},
      tasks: {
        build: { run: ['make', 'build'], cwd: '{worktree.root}' },
        legacy: { run: 'source scripts/env.sh && make dev', shell: true, background: true, singleton: true },
      },
    });

    expect(plan.tasks).toEqual({
      build: { run: ['make', 'build'], cwd: '{worktree.root}' },
      legacy: { run: 'source scripts/env.sh && make dev', shell: true, background: true, singleton: true },
    });
  });

  it('normalizes a legacy V1 plan without task contributions at both plan boundaries', () => {
    const legacyPlan: unknown = {
      resources: [],
      actions: [{ type: 'exec', argv: ['cargo', 'fetch'] }],
      capabilities: { 'deps.install': { action: 'cargo.fetch' } },
    };
    const normalizedPlan: AdapterPlan = {
      resources: [],
      actions: [{ type: 'exec', argv: ['cargo', 'fetch'] }],
      capabilities: { 'deps.install': { action: 'cargo.fetch' } },
      tasks: {},
    };

    expect(adapterPlanResponseSchema.parse(legacyPlan)).toEqual(normalizedPlan);
    expect(parseAdapterResponse('plan', legacyPlan)).toEqual(normalizedPlan);
  });

  it('still rejects unknown plan keys while normalizing legacy task input', () => {
    expect(() => adapterPlanResponseSchema.parse({
      resources: [],
      actions: [],
      capabilities: {},
      unknown: true,
    })).toThrow();
  });

  it('accepts documented plan resources, capabilities, and every V1 action', () => {
    const plan = adapterPlanResponseSchema.parse({
        resources: [{ name: 'cargo-target', type: 'build-output', path: 'target', policy: 'isolated', retention: 'ephemeral' }],
        capabilities: { 'deps.install': { action: 'cargo.fetch' } },
        tasks: {},
        actions: [
          { type: 'ensure-directory', path: '.cache' },
          { type: 'symlink', source: '.env.shared', target: '.env' },
          { type: 'copy', source: 'source', target: 'target' },
          { type: 'clone', source: 'seed', target: 'data' },
          { type: 'write-generated-file', path: '.env.generated', contents: 'PORT=3000' },
          { type: 'reserve-endpoint', name: 'api' },
          { type: 'exec', argv: ['cargo', 'fetch'], cwd: '{worktree.root}', timeoutMs: 600000 },
          { type: 'register-runtime-namespace', namespace: 'app-auth' },
        ],
    });

    expect(plan.actions).toHaveLength(8);
    expect(plan.actions.map((action) => action.type)).toEqual([
      'ensure-directory', 'symlink', 'copy', 'clone', 'write-generated-file',
      'reserve-endpoint', 'exec', 'register-runtime-namespace',
    ]);
  });

  it('associates a payload with its request operation', () => {
    expect(() => parseAdapterResponse('metadata', { detected: true, confidence: 1, evidence: [] })).toThrow();
  });

  it('accepts structured doctor findings and cleanup ownership references', () => {
    expect(adapterDoctorResponseSchema.parse({ findings: [] })).toEqual({ findings: [] });
    expect(
      adapterCleanupPlanResponseSchema.parse({
        actions: [{ type: 'delete-owned-resource', resource: 'cargo-target' }],
      }),
    ).toMatchObject({ actions: [{ resource: 'cargo-target' }] });
  });
});
