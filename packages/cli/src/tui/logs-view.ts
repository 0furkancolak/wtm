import type { JsonEnvelope, WtmError } from '@wtm/protocol';
import { z } from 'zod';

/**
 * The pure data-aggregation step for the log-tail view (unit 3 of item 15).
 *
 * Unlike every other TUI data source (`view-model.ts`'s `status`/`doctor`, `resources-view.ts`'s
 * `disk`/`gc --dry-run`), the daemon's `logs` handler is not read-only: every record it returns
 * calls `RuntimeController#observeActivity` for that record's worktree/task
 * (`packages/daemon/src/runtime-controller.ts`, `request.command === 'logs'`), which feeds
 * idle-runtime suspension (todo item 14) the same way `wtm ps` does — see `loop.ts` and
 * `render.ts`'s doc comments for why `ps` is never polled by this dashboard. `logs` has no
 * activity-free counterpart in the stable protocol today, so this module deliberately does not
 * reshape a passively-polled envelope the way `resources-view.ts` does: `buildTuiLogsView` is only
 * ever called from the log view's own explicit refresh in `loop.ts`, never from the background
 * dashboard tick. This file turns the envelope `wtm logs`'s own assembly
 * (`packages/cli/src/commands/logs.ts`'s `runLogsCommand`) already produces into a flat view — it
 * invents no second way to read log content.
 */

const logEntrySchema = z.object({
  processId: z.string().min(1),
  taskName: z.string().min(1),
  stdout: z.string(),
  stderr: z.string(),
}).passthrough();

const logsDataSchema = z.object({
  logs: z.array(logEntrySchema),
  truncated: z.boolean().optional(),
}).passthrough();

export interface TuiLogEntryView {
  readonly processId: string;
  readonly taskName: string;
  readonly stdoutLines: readonly string[];
  readonly stderrLines: readonly string[];
}

export interface TuiLogsView {
  readonly fetchedAt: string;
  readonly entries: readonly TuiLogEntryView[];
  /** `logs`'s own payload-budget truncation (`packages/daemon/src/runtime-controller.ts`). */
  readonly truncated: boolean;
  /** Envelope-level errors from `logs`, surfaced verbatim rather than swallowed. */
  readonly errors: readonly WtmError[];
}

/**
 * How many trailing lines of each stream to keep per task. `logs`'s own IPC-frame budget already
 * bounds the raw payload to tens of kilobytes total (`maximumLogPayloadBytes`), so this is purely
 * about keeping the rendered view readable, not about memory.
 */
const defaultMaxLinesPerStream = 200;

export function buildTuiLogsView(
  envelope: JsonEnvelope<unknown>,
  fetchedAt: string,
  maxLinesPerStream = defaultMaxLinesPerStream,
): TuiLogsView {
  const parsed = logsDataSchema.safeParse(envelope.data);
  const entries: TuiLogEntryView[] = parsed.success ? parsed.data.logs.map((log) => ({
    processId: log.processId,
    taskName: log.taskName,
    stdoutLines: tailLines(log.stdout, maxLinesPerStream),
    stderrLines: tailLines(log.stderr, maxLinesPerStream),
  })) : [];
  return {
    fetchedAt,
    entries,
    truncated: parsed.success && parsed.data.truncated === true,
    errors: envelope.errors,
  };
}

/** The trailing `max` lines of `text`, dropping the empty line a final trailing newline leaves. */
function tailLines(text: string, max: number): readonly string[] {
  if (text.length === 0) return [];
  const rawLines = text.split('\n');
  const lines = rawLines.at(-1) === '' ? rawLines.slice(0, -1) : rawLines;
  return lines.length <= max ? lines : lines.slice(lines.length - max);
}
