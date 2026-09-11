import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { selectPlatformRuntime } from '@wtm/platform';
import type { WtmErrorCode } from '@wtm/protocol';
import { servicePathsFor, type ServicePaths } from '@wtm/daemon/service-lifecycle';

/**
 * The one place a daemon that could not start leaves its reason (spec decision 4 and R4).
 *
 * One document, rewritten, never appended: it cannot grow, and it is the only record that
 * survives a crash loop, because every launch is a new process with an empty memory.
 */
export const daemonStatusFileName = 'daemon-status.json';

export type DaemonStartupOutcome =
  | { started: true }
  | {
    started: false;
    code: WtmErrorCode;
    /** The reporter's one-line condition: what repeats, and what de-duplication keys on. */
    condition: string;
    message: string;
    remediation: string[] | null;
    permanent: boolean;
  };

const daemonStatusSchema = z.object({
  schemaVersion: z.literal(1),
  state: z.enum(['running', 'failed']),
  at: z.string().datetime(),
  pid: z.number().int().positive(),
  since: z.string().datetime(),
  attempts: z.number().int().positive(),
  code: z.string().nullable(),
  condition: z.string().nullable(),
  message: z.string().nullable(),
  remediation: z.array(z.string()).min(1).nullable(),
  permanent: z.boolean(),
}).strict();

export type DaemonStatus = z.infer<typeof daemonStatusSchema>;

export function daemonStatusPath(logRoot: string): string {
  return join(logRoot, daemonStatusFileName);
}

/** This HOME's service paths on this host, or `null` on a host WTM has no backend for. */
export function servicePathsForHost(): ServicePaths | null {
  try {
    return servicePathsFor(selectPlatformRuntime().service, { home: homedir(), env: process.env });
  } catch {
    return null;
  }
}

export function readDaemonStatus(path: string): DaemonStatus | null {
  try {
    return daemonStatusSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

/** Best effort, like the error log: a status that cannot be written must not mask the failure. */
export function writeDaemonStatus(path: string, status: DaemonStatus): void {
  const temporary = `${path}.${String(process.pid)}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify(status)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    // Deliberately silent, like the write itself -- but the temp name is keyed on this launch's
    // pid, so a rename that fails on every launch (something other than a file already sitting at
    // `path`) would otherwise leave a new file every launch of the very crash loop this record
    // exists to bound.
    try { unlinkSync(temporary); } catch { /* best effort */ }
  }
}

export function nextDaemonStatus(
  previous: DaemonStatus | null,
  outcome: DaemonStartupOutcome,
  now: Date,
  pid: number,
): DaemonStatus {
  const at = now.toISOString();
  if (outcome.started) {
    return {
      schemaVersion: 1, state: 'running', at, pid, since: at, attempts: 1,
      code: null, condition: null, message: null, remediation: null, permanent: false,
    };
  }
  const repeat = previous !== null && previous.state === 'failed' && previous.condition === outcome.condition;
  return {
    schemaVersion: 1,
    state: 'failed',
    at,
    pid,
    since: repeat ? previous.since : at,
    attempts: repeat ? previous.attempts + 1 : 1,
    code: outcome.code,
    condition: outcome.condition,
    message: outcome.message,
    remediation: outcome.remediation,
    permanent: outcome.permanent,
  };
}

/** A remediation argv as a person would paste it: quoted only where the shell needs it. */
export function formatRemediation(argv: readonly string[]): string {
  return argv.map((word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`)).join(' ');
}
