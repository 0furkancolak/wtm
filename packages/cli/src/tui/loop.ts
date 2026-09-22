import { runDoctorCommand, runStatusCommand, type DiagnosticDataSource } from '../diagnostics';
import { defaultTuiPanels, renderTuiFatalFrame, renderTuiFrame, type TuiPanel } from './render';
import { enterTuiTerminal } from './terminal';
import { buildTuiViewModel } from './view-model';

/**
 * The polling/refresh loop: fixed-interval timer, minimal key handling (`q`/ctrl+c to quit, `r`
 * to refresh now), terminal lifecycle on every exit path. This is the untestable glue CLAUDE.md's
 * test rules expect for real process/terminal behaviour — see `terminal.ts` — so it carries no
 * assertions of its own. `view-model.ts` and `render.ts` hold everything here that a test can mean
 * something for.
 *
 * It polls only `wtm status`/`wtm doctor` (via the same `DiagnosticDataSource` `wtm status --json`
 * and `wtm doctor --json` already use), never `wtm ps`. `ps`'s daemon handler marks every worktree
 * in scope active as a side effect (`RuntimeController#observeActivity`), which feeds idle-runtime
 * suspension (todo item 14) — a dashboard that called it every tick would defeat idle suspension
 * for as long as it stayed open. `status`'s `processes` array already answers "what is running
 * for this worktree" from the daemon's process records, with no such side effect.
 */

export interface RunTuiLoopOptions {
  readonly cwd: string;
  readonly selector?: string;
  readonly source: DiagnosticDataSource;
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
  readonly intervalMs?: number;
  readonly signal?: AbortSignal;
  readonly panels?: readonly TuiPanel[];
  /** Test/determinism seam for the frame timestamp; defaults to the real clock. */
  readonly now?: () => Date;
}

export interface TuiLoopResult {
  readonly exitCode: number;
}

const defaultIntervalMs = 3000;

export async function runTuiLoop(options: RunTuiLoopOptions): Promise<TuiLoopResult> {
  const intervalMs = options.intervalMs ?? defaultIntervalMs;
  const panels = options.panels ?? defaultTuiPanels;
  const now = options.now ?? (() => new Date());
  const size = (): { columns: number; rows: number } => ({
    columns: options.stdout.columns ?? 80,
    rows: options.stdout.rows ?? 24,
  });
  const terminal = enterTuiTerminal(options.stdin, options.stdout);

  return await new Promise<TuiLoopResult>((resolveLoop) => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let finished = false;

    const finish = (exitCode: number): void => {
      if (finished) return;
      finished = true;
      if (timer !== null) clearInterval(timer);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      options.stdin.off('data', onData);
      terminal.restore();
      resolveLoop({ exitCode });
    };

    const onSignal = (): void => finish(0);
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        finish(0);
        return;
      }
      options.signal.addEventListener('abort', () => finish(0), { once: true });
    }

    const refresh = async (): Promise<void> => {
      const input = { cwd: options.cwd, ...(options.selector === undefined ? {} : { selector: options.selector }) };
      try {
        const [statusEnvelope, doctorEnvelope] = await Promise.all([
          runStatusCommand(input, options.source),
          runDoctorCommand(input, options.source),
        ]);
        if (finished) return;
        const model = buildTuiViewModel({ statusEnvelope, doctorEnvelope, fetchedAt: now().toISOString() });
        options.stdout.write(renderTuiFrame(model, size(), panels));
      } catch (error) {
        if (finished) return;
        options.stdout.write(renderTuiFatalFrame(error instanceof Error ? error.message : String(error), size()));
      }
    };

    const onData = (chunk: string): void => {
      if (chunk.includes('\u0003') || chunk.includes('q') || chunk.includes('Q')) {
        finish(0);
        return;
      }
      if (chunk.includes('r') || chunk.includes('R')) void refresh();
    };
    options.stdin.on('data', onData);

    void refresh();
    timer = setInterval(() => { void refresh(); }, intervalMs);
  });
}
