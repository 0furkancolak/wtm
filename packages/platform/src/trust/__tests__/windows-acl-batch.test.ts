import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { type ChildProcessWithoutNullStreams, type spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { createWindowsAclBatchReader, readWindowsAclBatch } from '../windows-acl-batch';

const sid = 'S-1-5-21-42';
const acl = { OwnerSid: sid, DaclPresent: true,
  AccessRules: [{ Sid: sid, ControlType: 'Allow', Rights: 'FullControl' }] };
function response(paths: readonly string[]) {
  return JSON.stringify({ CurrentSid: sid, Entries: paths.map((Path) => ({ Path, Acl: acl })) });
}

test('one Windows ACL batch carries current SID and every exact requested path', async () => {
  let calls = 0;
  const paths = ["C:\\private\\quote' file", 'C:\\private\\log'];
  const batch = await readWindowsAclBatch(paths, { run: async (script) => {
    calls++;
    expect(script).toContain('DiscretionaryAcl');
    expect(script).toContain('DaclPresent');
    expect(script).toContain('$PSHOME');
    // Paths are encoded as data, never injected into PowerShell source.
    expect(script).not.toContain(paths[0]!);
    return response(paths);
  } });
  expect(calls).toBe(1);
  expect(batch.currentSid).toBe(sid);
  expect([...batch.acls.keys()]).toEqual(paths);
});

test('missing, duplicate, unexpected and malformed ACL records fail the whole batch', async () => {
  for (const Entries of [[], [{ Path: 'a', Acl: acl }, { Path: 'a', Acl: acl }],
    [{ Path: 'unexpected', Acl: acl }], [{ Path: 'a', Acl: { ...acl, DaclPresent: false } }],
    [{ Path: 'a', Acl: { ...acl, AccessRules: [null] } }]]) {
    await expect(readWindowsAclBatch(['a'], { run: async () => JSON.stringify({ CurrentSid: sid, Entries }) }))
      .rejects.toThrow();
  }
});

test('ACL batch input and output have hard bounds', async () => {
  let calls = 0;
  await expect(readWindowsAclBatch(Array.from({ length: 129 }, (_, i) => String(i)), {
    run: async () => { calls++; return ''; },
  })).rejects.toThrow();
  expect(calls).toBe(0);
  await expect(readWindowsAclBatch(['a'], { run: async () => ' '.repeat(1024 * 1024 + 1) })).rejects.toThrow();
});

test('an abort settles a pending ACL batch and ignores late valid evidence', async () => {
  const controller = new AbortController();
  let complete!: (value: string) => void;
  const result = readWindowsAclBatch(['a'], { signal: controller.signal,
    run: async () => await new Promise<string>((resolve) => { complete = resolve; }) });
  controller.abort();
  await expect(result).rejects.toThrow();
  complete(response(['a']));
});

test('already aborted ACL requests never start PowerShell', async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  await expect(readWindowsAclBatch(['a'], { signal: controller.signal,
    run: async () => { calls++; return response(['a']); } })).rejects.toThrow();
  expect(calls).toBe(0);
});

test('an aborted production helper holds its permit until close is observed', async () => {
  const children: (EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kills: number; kill(): boolean })[] = [];
  const spawnHelper = (_file: string, _args: string[]) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(),
      stderr: new PassThrough(), kills: 0, kill() { child.kills++; return true; } });
    child.stdin.resume(); children.push(child);
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  const read = createWindowsAclBatchReader({ spawn: spawnHelper as typeof spawn });
  const controller = new AbortController();
  const first = read(['a'], { signal: controller.signal });
  controller.abort();
  await expect(first).rejects.toThrow();
  expect(children[0]!.kills).toBe(1);
  await expect(read(['a'])).rejects.toThrow('WINDOWS_ACL_HELPER_BUSY');
  expect(children).toHaveLength(1);
  // Kill intent is not absence: only close releases the bounded helper permit.
  children[0]!.emit('close', null);
  const next = read(['a']);
  expect(children).toHaveLength(2);
  children[1]!.stdout.write(response(['a'])); children[1]!.emit('close', 0);
  expect((await next).currentSid).toBe(sid);
});

test('the production stdout boundary rejects invalid UTF-8 instead of replacement decoding', async () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(),
    stderr: new PassThrough(), kill() { return true; } });
  child.stdin.resume();
  const read = createWindowsAclBatchReader({ spawn: (() => child) as unknown as typeof spawn });
  const pending = read(['a']);
  const bytes = Buffer.from(response(['a']));
  const target = bytes.indexOf('FullControl'); bytes[target] = 0xff;
  child.stdout.write(bytes); child.emit('close', 0);
  await expect(pending).rejects.toThrow('WINDOWS_ACL_BATCH_ENCODING');
});
