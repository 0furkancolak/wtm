/**
 * Lifecycle proof for the pooled `powershell.exe` session. Nothing here starts a real process:
 * the point is the properties the pool must hold no matter what the host does to the child —
 * a dead session refuses, a slow one is bounded, and no call can reach another.
 */
import { describe, expect, test } from 'bun:test';
import { createPooledPowershellRunner, createPowershellSession, type PowershellChild, type PowershellSpawn } from '../windows-powershell-session';
import { createWindowsAclReader } from '../windows-powershell';
import { createWindowsFileTrustPolicy } from '../windows';

interface FakeChild {
  readonly writes: string[];
  kills: number;
  emit(key: string, value?: unknown): void;
  answer(token: string, value: string, ok?: boolean): void;
}

type Responder = (script: string, token: string) => { ok?: boolean; out: string } | undefined;

function frameOf(line: string): { token: string; script: string } | undefined {
  const token = /'([0-9a-f]{32}) '/.exec(line)?.[1];
  const encoded = /FromBase64String\('([A-Za-z0-9+/=]*)'\)/.exec(line)?.[1];
  if (token === undefined || encoded === undefined) return undefined;
  return { token, script: Buffer.from(encoded, 'base64').toString('utf8') };
}

function fakePowershell(respond?: Responder): { children: FakeChild[]; spawn: PowershellSpawn } {
  const children: FakeChild[] = [];
  const spawn: PowershellSpawn = () => {
    const writes: string[] = [];
    const handlers = new Map<string, ((value: unknown) => void)[]>();
    function on(key: string, listener: (value: unknown) => void): void {
      const existing = handlers.get(key);
      if (existing === undefined) handlers.set(key, [listener]); else existing.push(listener);
    }
    function emit(key: string, value?: unknown): void {
      for (const listener of [...(handlers.get(key) ?? [])]) listener(value);
    }
    function answer(token: string, value: string, ok = true): void {
      emit('stdout:data', Buffer.from(`${token} ${ok ? '1' : '0'} ${Buffer.from(value, 'utf8').toString('base64')}\n`));
    }
    const child = {
      writes, kills: 0, emit, answer,
      stdin: {
        write(chunk: string) {
          writes.push(chunk);
          const parsed = frameOf(chunk);
          if (respond === undefined || parsed === undefined) return true;
          const reply = respond(parsed.script, parsed.token);
          if (reply !== undefined) queueMicrotask(() => { answer(parsed.token, reply.out, reply.ok ?? true); });
          return true;
        },
        on(event: string, listener: (value: unknown) => void) { on(`stdin:${event}`, listener); },
      },
      stdout: { on(event: string, listener: (value: unknown) => void) { on(`stdout:${event}`, listener); } },
      stderr: { on(event: string, listener: (value: unknown) => void) { on(`stderr:${event}`, listener); } },
      on(event: string, listener: (value: unknown) => void) { on(`child:${event}`, listener); },
      once(event: string, listener: (value: unknown) => void) { on(`child:${event}`, listener); },
      kill() { child.kills += 1; return true; },
    };
    children.push(child as unknown as FakeChild);
    return child as unknown as PowershellChild;
  };
  return { children, spawn };
}

const aclJson = JSON.stringify({
  DaclPresent: true, OwnerSid: 'S-1-5-21-1-2-3-1001',
  AccessRules: [{ Sid: 'S-1-5-21-1-2-3-1001', Rights: 'FullControl', ControlType: 'Allow' }],
});

describe('the pooled session spends one powershell.exe, not one per call', () => {
  test('fifty ACL reads start exactly one process and import the security module once', async () => {
    const host = fakePowershell(() => ({ out: aclJson }));
    const runner = createPooledPowershellRunner({ spawn: host.spawn });
    const readAcl = createWindowsAclReader(runner);
    try {
      for (let call = 0; call < 50; call++) {
        expect(await readAcl(`C:\\logs\\task-${String(call)}`)).toEqual({
          ownerSid: 'S-1-5-21-1-2-3-1001',
          accessRules: [{ identitySid: 'S-1-5-21-1-2-3-1001', fileSystemRights: 'FullControl', accessControlType: 'Allow' }],
        });
      }
      expect(host.children).toHaveLength(1);
      const prologue = host.children[0]!.writes.filter((line) => line.includes('Import-Module'));
      // One prologue import for the whole session; the per-request script keeps its own import,
      // which is the module-shadowing fix this must not undo.
      expect(prologue).toHaveLength(1);
      expect(host.children[0]!.writes.filter((line) => frameOf(line) !== undefined)).toHaveLength(50);
    } finally { runner.close(); }
  });

  test('no path reaches the wire as script text, however it is spelled', async () => {
    const host = fakePowershell(() => ({ out: aclJson }));
    const runner = createPooledPowershellRunner({ spawn: host.spawn });
    const hostile = "C:\\logs\\'; Start-Process calc; #\\$(whoami)`n\u00e7\u00f6\u011f";
    try {
      await createWindowsAclReader(runner)(hostile);
      const frames = host.children[0]!.writes.filter((line) => frameOf(line) !== undefined);
      expect(frames).toHaveLength(1);
      expect(frames[0]).not.toContain('Start-Process');
      expect(frames[0]).not.toContain('whoami');
      // The path survives intact inside the decoded request script, as data.
      expect(frameOf(frames[0]!)!.script).toContain(Buffer.from(hostile, 'utf8').toString('base64'));
      expect(frameOf(frames[0]!)!.script).not.toContain('Start-Process');
    } finally { runner.close(); }
  });
});

describe('a session that dies is a refusal, never a trusted answer', () => {
  for (const [name, kill] of [
    ['the host kills the process', (child: FakeChild) => { child.emit('child:close', 9); }],
    ['the process never starts', (child: FakeChild) => { child.emit('child:error', new Error('ENOENT')); }],
    ['stdin breaks under it', (child: FakeChild) => { child.emit('stdin:error', new Error('EPIPE')); }],
  ] as const) {
    test(`${name}: the in-flight call refuses and the policy denies`, async () => {
      const host = fakePowershell();
      const runner = createPooledPowershellRunner({ spawn: host.spawn });
      const policy = createWindowsFileTrustPolicy({
        readAcl: createWindowsAclReader(runner),
        currentUserSid: async () => 'S-1-5-21-1-2-3-1001',
      });
      try {
        const asked = policy.isOwnedByCurrentUser({ uid: 0, mode: 0, nlink: 1 }, 'C:\\logs\\task');
        await Promise.resolve();
        kill(host.children[0]!);
        expect(await asked).toBe(false);
      } finally { runner.close(); }
    });
  }

  test('a killed session is replaced for the next caller rather than poisoning it', async () => {
    const host = fakePowershell();
    const session = createPowershellSession({ spawn: host.spawn });
    try {
      const first = session.run('Get-Acl');
      await Promise.resolve();
      host.children[0]!.emit('child:close', 1);
      await expect(first).rejects.toThrow('POWERSHELL_SESSION_CLOSED');
      const second = session.run('Get-Acl');
      await Promise.resolve();
      expect(host.children).toHaveLength(2);
      const parsed = frameOf(host.children[1]!.writes.at(-1)!)!;
      host.children[1]!.answer(parsed.token, 'S-1-5-18');
      expect(await second).toBe('S-1-5-18');
    } finally { session.close(); }
  });

  test('a script that fails inside the session rejects instead of resolving empty output', async () => {
    const host = fakePowershell(() => ({ ok: false, out: '' }));
    const session = createPowershellSession({ spawn: host.spawn });
    try { await expect(session.run('Get-Acl -LiteralPath $p')).rejects.toThrow('POWERSHELL_SESSION_COMMAND_FAILED'); }
    finally { session.close(); }
  });
});

describe('one call cannot reach another', () => {
  test('concurrent callers are serialized and each gets its own answer', async () => {
    const answers = new Map<string, string>();
    const host = fakePowershell((script, token) => {
      answers.set(token, script);
      return { out: script.includes('alpha') ? 'ALPHA' : 'BETA' };
    });
    const session = createPowershellSession({ spawn: host.spawn });
    try {
      const both = await Promise.all([session.run('alpha'), session.run('beta')]);
      expect(both).toEqual(['ALPHA', 'BETA']);
      expect(host.children).toHaveLength(1);
      // Two distinct tokens: a frame can only ever settle the request that minted it.
      expect(new Set(answers.keys()).size).toBe(2);
    } finally { session.close(); }
  });

  test('a late frame from a failed request cannot settle the request that followed it', async () => {
    const host = fakePowershell();
    const session = createPowershellSession({ spawn: host.spawn, requestTimeoutMs: 5 });
    try {
      const abandoned = session.run('first');
      await Promise.resolve();
      const stale = frameOf(host.children[0]!.writes.at(-1)!)!;
      await expect(abandoned).rejects.toThrow('POWERSHELL_SESSION_TIMEOUT');
      expect(host.children[0]!.kills).toBe(1);
      const next = session.run('second');
      await Promise.resolve();
      const child = host.children[1]!;
      child.answer(stale.token, 'WRONG');
      let settled = false;
      void next.then(() => { settled = true; }, () => { settled = true; });
      await Promise.resolve(); await Promise.resolve();
      expect(settled).toBe(false);
      const fresh = frameOf(child.writes.at(-1)!)!;
      child.answer(fresh.token, 'RIGHT');
      expect(await next).toBe('RIGHT');
    } finally { session.close(); }
  });

  test('each request re-establishes error preference and working directory before running', async () => {
    const host = fakePowershell(() => ({ out: 'ok' }));
    const session = createPowershellSession({ spawn: host.spawn });
    try {
      await session.run('one');
      await session.run('two');
      for (const line of host.children[0]!.writes.filter((value) => frameOf(value) !== undefined)) {
        expect(line).toContain("$ErrorActionPreference = 'Stop'");
        expect(line).toContain('Set-Location -LiteralPath $WtmOrigin');
        // The caller's script runs in its own scope, so its variables cannot outlive it.
        expect(line).toContain('[ScriptBlock]::Create($WtmScript)');
      }
    } finally { session.close(); }
  });
});

describe('nothing about the session is unbounded', () => {
  test('a request that outlives its deadline kills the session rather than waiting', async () => {
    const host = fakePowershell();
    const session = createPowershellSession({ spawn: host.spawn, requestTimeoutMs: 5 });
    try {
      await expect(session.run('slow')).rejects.toThrow('POWERSHELL_SESSION_TIMEOUT');
      expect(host.children[0]!.kills).toBe(1);
    } finally { session.close(); }
  });

  test('the queue has a depth bound and a waiting bound, and both refuse rather than grow', async () => {
    const host = fakePowershell();
    const session = createPowershellSession({ spawn: host.spawn, maxQueued: 2, requestTimeoutMs: 10_000, queueTimeoutMs: 5 });
    try {
      const running = session.run('running');
      const queued = [session.run('a'), session.run('b')];
      await expect(session.run('c')).rejects.toThrow('POWERSHELL_SESSION_QUEUE_LIMIT');
      await expect(Promise.all(queued)).rejects.toThrow('POWERSHELL_SESSION_QUEUE_TIMEOUT');
      void running.catch(() => {});
    } finally { session.close(); }
  });

  test('a session is recycled by age and by request count, and never mid-request', async () => {
    let clock = 0;
    const host = fakePowershell(() => ({ out: 'ok' }));
    const byCount = createPowershellSession({ spawn: host.spawn, maxRequests: 3, now: () => clock });
    try {
      for (let call = 0; call < 7; call++) expect(await byCount.run('x')).toBe('ok');
      expect(host.children).toHaveLength(3);
      expect(host.children[0]!.writes.filter((line) => frameOf(line) !== undefined)).toHaveLength(3);
    } finally { byCount.close(); }

    const aged = fakePowershell(() => ({ out: 'ok' }));
    const byAge = createPowershellSession({ spawn: aged.spawn, maxLifetimeMs: 100, now: () => clock });
    try {
      await byAge.run('x');
      expect(aged.children).toHaveLength(1);
      clock = 250;
      await byAge.run('x');
      expect(aged.children).toHaveLength(2);
    } finally { byAge.close(); }
  });

  test('an idle session ends its process instead of holding it for the daemon lifetime', async () => {
    const host = fakePowershell(() => ({ out: 'ok' }));
    const session = createPowershellSession({ spawn: host.spawn, idleTimeoutMs: 5 });
    try {
      await session.run('x');
      expect(host.children[0]!.kills).toBe(0);
      await new Promise<void>((resolve) => { setTimeout(resolve, 25); });
      expect(host.children[0]!.kills).toBe(1);
      await session.run('x');
      expect(host.children).toHaveLength(2);
    } finally { session.close(); }
  });

  test('output past the bound fails the request and replaces the session', async () => {
    const host = fakePowershell();
    const session = createPowershellSession({ spawn: host.spawn, maxResponseBytes: 64 });
    try {
      const pending = session.run('loud');
      await Promise.resolve();
      host.children[0]!.emit('stdout:data', Buffer.alloc(128, 0x61));
      await expect(pending).rejects.toThrow('POWERSHELL_SESSION_OUTPUT_LIMIT');
      expect(host.children[0]!.kills).toBe(1);
    } finally { session.close(); }
  });

  test('closing the session refuses everything queued behind it', async () => {
    const host = fakePowershell();
    const session = createPowershellSession({ spawn: host.spawn });
    const running = session.run('a');
    const waiting = session.run('b');
    session.close();
    await expect(running).rejects.toThrow('POWERSHELL_SESSION_CLOSED');
    await expect(waiting).rejects.toThrow('POWERSHELL_SESSION_CLOSED');
    await expect(session.run('c')).rejects.toThrow('POWERSHELL_SESSION_CLOSED');
  });
});
