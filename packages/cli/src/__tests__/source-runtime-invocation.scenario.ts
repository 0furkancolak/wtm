import { selfRuntimeInvocation } from '../../../platform/src/index';

/**
 * Prints the re-invocation this process composes for itself. The test that spawns this file gives
 * the parent a loader flag *and* a debugger flag, so the printed invocation is the real answer to
 * "what does `process.execArgv` contribute?" rather than a hand-built host object's answer.
 */
console.log(JSON.stringify({
  execArgv: process.execArgv,
  invocation: selfRuntimeInvocation(),
}));
