import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface RuntimeInvocation {
  executable: string;
  prefixArgs: readonly string[];
}

/**
 * WTM spawns its own executable for private runner modes. Installed variants point at the
 * packaged CLI, so development runs point at the TypeScript entry under the Node runtime
 * that production requires. Bun drives the suite but cannot host the runner modes.
 */
export function developmentRuntimeInvocation(): RuntimeInvocation {
  return {
    executable: developmentNodeExecutable(),
    prefixArgs: [
      '--import',
      import.meta.resolve('tsx'),
      fileURLToPath(new URL('../../cli/src/bin.ts', import.meta.url)),
    ],
  };
}

export function developmentNodeExecutable(): string {
  return Object.hasOwn(process.versions, 'bun')
    ? execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim()
    : process.execPath;
}
