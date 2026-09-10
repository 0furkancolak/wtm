import { createHash } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { join as posixJoin } from 'node:path/posix';
import { resolve as win32Resolve } from 'node:path/win32';

/** A real local transport address, isolated by the fixture directory and endpoint name. */
export function fixtureIpcAddress(
  root: string,
  name = 'wtmd.sock',
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') return posixJoin(root, name);
  const digest = createHash('sha256').update(JSON.stringify([win32Resolve(root), name])).digest('hex');
  return `\\\\.\\pipe\\wtm-test-${digest}`;
}

interface IpcAbsenceOptions {
  timeoutMs?: number;
  /** Fault injection stays at the socket boundary; ordinary callers use a real connection. */
  connect?: (address: string) => Socket;
}

/** Named pipes have no filesystem entry. Only an explicit connection refusal proves absence. */
export async function ipcEndpointAbsent(address: string, options: IpcAbsenceOptions = {}): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 500;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000) {
    throw new RangeError('IPC absence timeout must be between 1 and 5000 milliseconds');
  }
  return await new Promise<boolean>((resolve, reject) => {
    const socket = (options.connect ?? createConnection)(address);
    let settled = false;
    const finish = (absent: boolean, error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error === undefined) resolve(absent);
      else reject(error);
    };
    const timer = setTimeout(() => finish(false, Object.assign(
      new Error('IPC absence probe timed out without evidence of absence'), { code: 'ETIMEDOUT' },
    )), timeoutMs);
    socket.once('connect', () => finish(false));
    // Retain the error listener until the destroyed handle is collected: a late error must not
    // become an unhandled event after connect/timeout already settled this observation.
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') finish(true);
      else finish(false, error);
    });
  });
}
