import { describe, expect, it } from 'bun:test';
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
} from './adapter.js';

describe('adapter protocol schemas', () => {
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
      }),
    ).toThrow();
  });

  it('accepts documented plan resources, capabilities, and every V1 action', () => {
    const plan = adapterPlanResponseSchema.parse({
        resources: [{ name: 'cargo-target', type: 'build-output', path: 'target', policy: 'isolated', retention: 'ephemeral' }],
        capabilities: { 'deps.install': { action: 'cargo.fetch' } },
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
