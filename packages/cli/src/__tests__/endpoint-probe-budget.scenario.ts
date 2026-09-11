import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

const cliEntry = fileURLToPath(new URL('../bin.ts', import.meta.url));
const busy = createSocket('udp4');
const free = createSocket('udp4');
try {
  for (const socket of [busy, free]) await new Promise<void>((resolve, reject) => {
    socket.once('error', reject); socket.bind(0, '127.0.0.1', resolve);
  });
  const busyPort = busy.address().port;
  const freePort = free.address().port;
  await new Promise<void>((resolve) => free.close(resolve));
  const candidates = Array.from({ length: 256 }, (_, index) => ({ protocol: 'udp' as const, host: '127.0.0.1', port: index === 255 ? freePort : busyPort }));
  const args = ['--import', 'tsx', cliEntry, '__wtm_internal_endpoint_batch_probe'];
  // POSIX enforces a small descriptor budget in the helper only. Windows still exercises
  // the complete busy/free sequence; this is not a Windows descriptor-limit assertion.
  const result = process.platform === 'win32'
    ? runScenario(process.execPath, args, { input: JSON.stringify({ candidates }) })
    : runScenario('/bin/sh', ['-c', 'ulimit -n 128; exec "$@"', 'wtm-probe-budget', process.execPath, ...args], { input: JSON.stringify({ candidates }) });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { available: [...Array.from({ length: 255 }, () => false), true] });
} finally {
  try { free.close(); } catch { /* Closed before the final free probe. */ }
  busy.close();
}
process.stdout.write('passed\n');
