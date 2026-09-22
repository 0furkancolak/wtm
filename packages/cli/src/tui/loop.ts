import type { JsonEnvelope } from '@wtm/protocol';
import { runDoctorCommand, runStatusCommand, type DiagnosticDataSource } from '../diagnostics';
import { buildTuiLogsView, type TuiLogsView } from './logs-view';
import { defaultTuiPanels, renderTuiFatalFrame, renderTuiFrame, renderTuiLogsFrame, type TuiPanel } from './render';
import { buildTuiResourcesView, type TuiResourceFetch, type TuiResourcesView } from './resources-view';
import { enterTuiTerminal } from './terminal';
import { buildTuiViewModel } from './view-model';

/**
 * The polling/refresh loop: fixed-interval timer, minimal key handling (`q`/ctrl+c to quit, `r`
 * to refresh now, `l`/Escape to switch to/from the log-tail view), terminal lifecycle on every
 * exit path. This is the untestable glue CLAUDE.md's test rules expect for real process/terminal
 * behaviour — see `terminal.ts` — so it carries no assertions of its own. `view-model.ts`,
 * `resources-view.ts`, `logs-view.ts` and `render.ts` hold everything here that a test can mean
 * something for.
 *
 * It polls only `wtm status`/`wtm doctor` (via the same `DiagnosticDataSource` `wtm status --json`
 * and `wtm doctor --json` already use), never `wtm ps`. `ps`'s daemon handler marks every worktree
 * in scope active as a side effect (`RuntimeController#observeActivity`), which feeds idle-runtime
 * suspension (todo item 14) — a dashboard that called it every tick would defeat idle suspension
 * for as long as it stayed open. `status`'s `processes` array already answers "what is running
 * for this worktree" from the daemon's process records, with no such side effect.
 *
 * The loop has two modes, `'dashboard'` (default) and `'logs'` (unit 3's log-tail view), entered
 * and left with the `l`/Escape keys handled below. Exactly one mode's frame is fetched and drawn
 * per refresh — never both — because `wtm logs` (`readLogs`) is not read-only the way
 * `status`/`doctor`/the resources panel are: the daemon's `logs` handler calls
 * `RuntimeController#observeActivity` for every record it returns, the same side effect `ps` has.
 * A dashboard silently polling `ps` in the background is not real user activity, but the log view
 * only ever polls `logs` while it is the mode actually on screen — never as part of the passive
 * `'dashboard'`-mode refresh cycle — so leaving the dashboard open and walking away still never
 * touches `logs`. See `logs-view.ts`'s doc comment for the full reasoning.
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
  /**
   * Fetches the disk-usage / cleanup-candidate panel's data (unit 2): the exact same
   * `runProductionDiskCommand`/`runProductionGcCommand` (`apply: false`) assembly `wtm disk` and
   * `wtm gc --dry-run` already use, wired in by `main.ts`. Omitted in a test that only exercises
   * status/doctor, in which case that panel simply never populates.
   */
  readonly readResources?: (cwd: string) => Promise<TuiResourceFetch>;
  /**
   * How many status/doctor ticks pass between resource refreshes — see the constant below for why
   * this defaults to more than 1. A manual `r` refresh always re-fetches resources immediately
   * regardless of this count, since that is one explicit request rather than automatic polling.
   */
  readonly resourceRefreshEveryNTicks?: number;
  /**
   * Fetches log content for the log-tail view (unit 3): the exact same `runLogsCommand` assembly
   * `wtm logs` already uses, wired in by `main.ts` with `dependencies.runtimeClient`. Takes the
   * worktree cwd to read logs for (the last resolved `status` identity path — see `refreshLogs`
   * below) and no `taskName`, since the view shows every task's logs stacked rather than one at a
   * time. Omitted in a test that only exercises the dashboard, in which case pressing `l` shows an
   * "unavailable" frame instead of fetching anything. Called only while the `'logs'` mode is the
   * one on screen — see the module doc comment above for why.
   */
  readonly readLogs?: (cwd: string) => Promise<JsonEnvelope<unknown>>;
}

export interface TuiLoopResult {
  readonly exitCode: number;
}

const defaultIntervalMs = 3000;

/**
 * Unlike `status`/`doctor`'s SQLite-only reads, assembling the resources panel's data does real
 * filesystem work: `resource-production.ts`'s worktree-local resource measurement walks the
 * resource directories with `lstat`/`readdir` (its own doc comment says so), and a `gc` dry-run
 * re-runs that same walk plus a `lstat` per GC candidate. Polling that every tick at the TUI's
 * default 3s interval would repeat a filesystem walk far more often than the data can plausibly
 * change, for a panel most users only glance at occasionally — five ticks (about 15s at the
 * default interval) keeps it feeling live without doing that walk on every frame. This is a fixed
 * multiplier of the one interval the TUI already has, not a second configurable interval, because
 * nothing here calls for tuning it independently.
 */
const defaultResourceRefreshEveryNTicks = 5;

export async function runTuiLoop(options: RunTuiLoopOptions): Promise<TuiLoopResult> {
  const intervalMs = options.intervalMs ?? defaultIntervalMs;
  const panels = options.panels ?? defaultTuiPanels;
  const now = options.now ?? (() => new Date());
  const resourceRefreshEveryNTicks = Math.max(1, options.resourceRefreshEveryNTicks ?? defaultResourceRefreshEveryNTicks);
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

    let resourceTick = 0;
    let resources: TuiResourcesView | null = null;
    // The dashboard's own `status` resolves the worktree in scope (`options.cwd`/`selector`) to a
    // concrete path (`model.worktree.path`); the log view reuses that same resolved path rather
    // than re-resolving a selector itself, so it stays scoped to the one worktree the dashboard is
    // already showing. Falls back to `options.cwd` until the first dashboard fetch resolves one.
    let lastWorktreeCwd = options.cwd;
    let mode: 'dashboard' | 'logs' = 'dashboard';
    let logsView: TuiLogsView | null = null;

    const refreshDashboard = async (trigger: 'timer' | 'manual'): Promise<void> => {
      const input = { cwd: options.cwd, ...(options.selector === undefined ? {} : { selector: options.selector }) };
      // A manual `r` press always re-fetches; an automatic tick only does on every Nth one —
      // see `defaultResourceRefreshEveryNTicks`'s doc comment for why. `resourceTick` starts at 0,
      // so the very first refresh (manual or not) is always due, and the panel never sits on
      // "not yet fetched" for a full cadence period after startup.
      const dueForResources = options.readResources !== undefined
        && (trigger === 'manual' || resourceTick % resourceRefreshEveryNTicks === 0);
      resourceTick += 1;
      try {
        const [statusEnvelope, doctorEnvelope, resourceSnapshot] = await Promise.all([
          runStatusCommand(input, options.source),
          runDoctorCommand(input, options.source),
          dueForResources ? options.readResources?.(options.cwd) : undefined,
        ]);
        if (finished) return;
        const fetchedAt = now().toISOString();
        if (resourceSnapshot !== undefined) resources = buildTuiResourcesView({ ...resourceSnapshot, fetchedAt });
        const model = buildTuiViewModel({ statusEnvelope, doctorEnvelope, fetchedAt, resources });
        if (model.worktree !== null) lastWorktreeCwd = model.worktree.path;
        options.stdout.write(renderTuiFrame(model, size(), panels));
      } catch (error) {
        if (finished) return;
        options.stdout.write(renderTuiFatalFrame(error instanceof Error ? error.message : String(error), size()));
      }
    };

    // Only ever invoked while `mode === 'logs'` — see the module doc comment for why `wtm logs`
    // (and the activity it marks) must never run as part of the passive dashboard tick.
    const refreshLogs = async (): Promise<void> => {
      if (options.readLogs === undefined) {
        options.stdout.write(renderTuiLogsFrame(logsView, size(), { available: false }));
        return;
      }
      try {
        const envelope = await options.readLogs(lastWorktreeCwd);
        if (finished) return;
        logsView = buildTuiLogsView(envelope, now().toISOString());
        options.stdout.write(renderTuiLogsFrame(logsView, size()));
      } catch (error) {
        if (finished) return;
        options.stdout.write(renderTuiFatalFrame(error instanceof Error ? error.message : String(error), size()));
      }
    };

    const refresh = async (trigger: 'timer' | 'manual' = 'timer'): Promise<void> => {
      if (mode === 'logs') await refreshLogs();
      else await refreshDashboard(trigger);
    };

    const onData = (chunk: string): void => {
      if (chunk.includes('\u0003') || chunk.includes('q') || chunk.includes('Q')) {
        finish(0);
        return;
      }
      // Escape only ever leaves the log view; it has no meaning on the dashboard, where it would
      // otherwise just be the lead byte of an arrow-key sequence this loop does not handle anyway.
      if (chunk.includes('\u001b') && mode === 'logs') {
        mode = 'dashboard';
        void refresh('manual');
        return;
      }
      if (chunk.includes('l') || chunk.includes('L')) {
        mode = mode === 'logs' ? 'dashboard' : 'logs';
        void refresh('manual');
        return;
      }
      if (chunk.includes('r') || chunk.includes('R')) void refresh('manual');
    };
    options.stdin.on('data', onData);

    void refresh();
    timer = setInterval(() => { void refresh(); }, intervalMs);
  });
}
