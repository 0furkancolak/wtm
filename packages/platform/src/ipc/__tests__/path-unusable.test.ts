import { describe, expect, test } from 'bun:test';
import { wtmErrorCodeSchema } from '@wtm/protocol';
import { IpcPathUnusableError } from '../path-unusable';

describe('IpcPathUnusableError', () => {
  test('carries a registered code, the path, the occupant and the owner', () => {
    const error = new IpcPathUnusableError('/tmp/x/.tmd.sock', 'file', 501);
    expect(wtmErrorCodeSchema.parse(error.code)).toBe('WTM_IPC_PATH_UNUSABLE');
    expect(error.severity).toBe('error');
    expect(error.context).toEqual({ path: '/tmp/x/.tmd.sock', occupant: 'file', ownerUid: 501 });
    expect(error.message).toContain('/tmp/x/.tmd.sock');
  });

  test('offers `rm` only where removing the path is the remedy', () => {
    expect(new IpcPathUnusableError('/p', 'file', 1).remediation)
      .toEqual([{ kind: 'command-suggestion', argv: ['rm', '/p'] }]);
    expect(new IpcPathUnusableError('/p', 'symlink', 1).remediation)
      .toEqual([{ kind: 'command-suggestion', argv: ['rm', '/p'] }]);
    for (const occupant of ['foreign-file', 'directory', 'foreign-socket', 'other'] as const) {
      expect(new IpcPathUnusableError('/p', occupant, 1).remediation)
        .toEqual([{ kind: 'command-suggestion', argv: ['wtm', 'doctor'] }]);
    }
  });

  test('never tells the user to remove something that belongs to someone else', () => {
    expect(new IpcPathUnusableError('/p', 'foreign-file', 0).message).toContain('will not remove');
    expect(new IpcPathUnusableError('/p', 'foreign-socket', 0).message).toContain('will not remove');
  });
});
