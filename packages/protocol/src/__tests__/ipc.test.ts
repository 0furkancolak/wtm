import { describe, expect, it } from 'bun:test';
import { ipcRequestSchema, ipcResponseSchema } from '../ipc';

describe('daemon IPC framing schemas', () => {
  it('requires a V1 protocol version on requests', () => {
    expect(() => ipcRequestSchema.parse({ id: 'request-1', command: 'status' })).toThrow();
  });

  it('bounds correlation IDs and command names before response construction', () => {
    expect(ipcRequestSchema.safeParse({
      protocol: { major: 1, minor: 0 }, id: 'x'.repeat(129), command: 'ps', arguments: {},
    }).success).toBe(false);
    expect(ipcRequestSchema.safeParse({
      protocol: { major: 1, minor: 0 }, id: 'id', command: 'x'.repeat(129), arguments: {},
    }).success).toBe(false);
  });

  it('accepts a versioned response containing an operational envelope', () => {
    expect(
      ipcResponseSchema.parse({
        protocol: { major: 1, minor: 0 },
        id: 'request-1',
        envelope: {
          schemaVersion: 1,
          ok: true,
          command: 'status',
          data: {},
          warnings: [],
          errors: [],
        },
      }),
    ).toMatchObject({ id: 'request-1', envelope: { ok: true } });
  });
});
