import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RuntimeInvocation {
  executable: string;
  prefixArgs: readonly string[];
}

let preparedInvocation: RuntimeInvocation | null = null;

/**
 * WTM spawns its own executable for private runner modes. Installed variants point at the
 * packaged CLI. Development builds the same private dispatcher before spawning its Node
 * runner: a cold tsx loader otherwise leaves an esbuild child inside the anchor's owned
 * group, which cannot drain until that compiler exits. Bun compiles outside that group;
 * it does not host the private runner modes.
 */
export function developmentRuntimeInvocation(): RuntimeInvocation {
  if (preparedInvocation !== null) return preparedInvocation;
  const executable = developmentNodeExecutable();
  const directory = mkdtempSync(join(tmpdir(), 'wtm-private-runtime-'));
  const bundlePath = join(directory, 'private-runtime.mjs');
  const cleanup = () => rmSync(directory, { recursive: true, force: true });
  try {
    chmodSync(directory, 0o700);
    execFileSync(Object.hasOwn(process.versions, 'bun') ? process.execPath : 'bun', [
      'build', fileURLToPath(new URL('./private-runtime.ts', import.meta.url)),
      '--target', 'node', '--outfile', bundlePath,
    ], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024,
    });
    chmodSync(bundlePath, 0o600);
  } catch (error) {
    cleanup();
    throw error;
  }
  preparedInvocation = { executable, prefixArgs: [bundlePath] };
  // Each caller process builds once. The loaded runner remains valid after its parent exits,
  // while no persistent compiler cache or generated source is left behind on normal exit.
  process.once('exit', cleanup);
  return preparedInvocation;
}

export function developmentNodeExecutable(): string {
  return Object.hasOwn(process.versions, 'bun')
    ? execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim()
    : process.execPath;
}
