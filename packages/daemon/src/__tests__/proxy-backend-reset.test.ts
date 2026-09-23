import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

const scenario = fileURLToPath(new URL('./proxy-backend-reset.scenario.ts', import.meta.url));

// Regression: the pass-through streaming branch of `ProxyServer#proxyRequest` (every non-HTML
// response — JSON, assets, the overwhelming majority of proxied traffic) attached no `'error'`
// listener to the backend's response. A backend that resets the connection after sending headers
// but before `'end'` (a crashed or restarting dev server) then never reached `.pipe()`'s
// completion path, so the client-facing response was left open forever: no more data, no error,
// no completion. This has to run as a real Node child (`runScenario`, not an in-process
// `bun:test`): the hang is specific to Node's http client's premature-close handling, which
// `bun test`'s own HTTP implementation does not reproduce.
test('daemon proxy ends the client response instead of hanging when the backend resets mid-stream', () => {
  const result = runScenario('node', ['--import', 'tsx', scenario], { timeoutMs: 15000 });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ outcome: 'settled' });
}, 20000);
