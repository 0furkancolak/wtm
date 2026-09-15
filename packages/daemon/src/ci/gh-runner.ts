import { spawn } from 'node:child_process';

export interface GhCommandResult {
  outcome: 'success' | 'not-found' | 'failure' | 'timeout';
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type GhCommandRunner = (argv: readonly string[]) => Promise<GhCommandResult>;

const terminationGraceMs = 2_000;

/**
 * Runs `gh` with argv only — never a shell — in the user's environment, so `gh` finds its own
 * credentials. WTM never reads or stores a token.
 */
export function createGhRunner(options: {
  executable?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
} = {}): GhCommandRunner {
  const executable = options.executable ?? 'gh';
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxOutputBytes = options.maxOutputBytes ?? 16 * 1024 * 1024;
  return async (argv) => await new Promise<GhCommandResult>((resolve) => {
    const child = spawn(executable, [...argv], {
      env: { ...(options.env ?? process.env), GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1', CLICOLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    let exceeded = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const terminate = () => {
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), terminationGraceMs);
      killTimer.unref();
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    timer.unref();
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      if (exceeded) return;
      bytes += chunk.length;
      if (bytes > maxOutputBytes) { exceeded = true; terminate(); return; }
      target.push(chunk);
    };
    child.stdout?.on('data', collect(stdout));
    child.stderr?.on('data', collect(stderr));
    const finish = (result: GhCommandResult) => {
      clearTimeout(timer);
      if (killTimer !== null) clearTimeout(killTimer);
      resolve(result);
    };
    child.once('error', (error: NodeJS.ErrnoException) => {
      finish({ outcome: error.code === 'ENOENT' ? 'not-found' : 'failure', exitCode: null, stdout: '', stderr: error.message });
    });
    child.once('close', (exitCode) => {
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
      if (timedOut) return finish({ outcome: 'timeout', exitCode, stdout: out, stderr: err });
      if (exceeded) return finish({ outcome: 'failure', exitCode, stdout: '', stderr: `gh output exceeded ${maxOutputBytes} bytes` });
      finish({ outcome: exitCode === 0 ? 'success' : 'failure', exitCode, stdout: out, stderr: err });
    });
  });
}
