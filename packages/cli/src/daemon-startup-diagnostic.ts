import { Socket } from 'node:net';
import { wtmErrorCodeSchema, type WtmError } from '@wtm/protocol';
import { formatRemediation, readDaemonStatus, type DaemonStatus } from './daemon-status';

/**
 * How long the reachability probe waits before calling the daemon absent.
 *
 * `doctor` is a read command a person is watching, so the probe is bounded rather than left to
 * the operating system's connect timeout. A daemon that has accepted the connection answers in
 * microseconds — a Unix socket has no network in it — so this budget is for a machine under
 * load, not for a slow answer.
 */
const daemonProbeTimeoutMs = 500;

export interface DaemonStartupDiagnosticOptions {
  /** The address to probe, or `null` when there is none: no platform, or a path too long to dial. */
  socketPath: () => string | null;
  /** Where the daemon records its last startup outcome, or `null` when there is no such place. */
  statusPath: () => string | null;
}

export interface DaemonStartupDiagnostic {
  /** Whether something is listening on the daemon's socket. Probed once, then remembered. */
  reachable(): Promise<boolean>;
  /** The daemon's own account of its last startup, when it says it failed. */
  recordedFailure(): DaemonStatus | null;
  /** The recorded failure as prose, opened by the reporting finding's own `lead` clause. */
  note(failure: DaemonStatus, lead: string): string;
  /**
   * Why the daemon is down, as an envelope item, or `null` when it is answering or nothing is on
   * record. For the answer that has no workspace to hang a finding on (todo item 52).
   *
   * Severity `warning`: it rides beside that answer rather than being it. Everywhere else a
   * recorded failure is a `doctor` finding, and findings do not move the exit code. Carried as an
   * error, it would, because an envelope exits with its worst error's class.
   */
  failureItem(): Promise<WtmError | null>;
}

/**
 * The daemon questions `doctor` can answer without the state database.
 *
 * Split out of `createStateDiagnosticDataSource` because that one needs a store, and the machine
 * that most needs to be told why the daemon is down is the one that has never run `wtm init`: it
 * has no database, so `doctor` there had nothing to ask (todo item 52). Everything here is about
 * the host — a socket and a status file — so it answers the same with or without a registry.
 */
export function createDaemonStartupDiagnostic(options: DaemonStartupDiagnosticOptions): DaemonStartupDiagnostic {
  let reachabilityProbe: Promise<boolean> | null = null;

  /**
   * Whether something is listening on the daemon's socket, without asking it anything.
   *
   * A connect is the whole question: the socket file outliving the process it belonged to is
   * exactly the case a stat cannot tell apart, and a running daemon accepts. Nothing is sent,
   * so this cannot disturb a daemon that is mid-request.
   */
  const reachable = async (): Promise<boolean> => {
    // One answer per command, not one per workspace: the socket is a property of the host, so
    // `doctor --global` across five workspaces would otherwise open five connections and wait
    // up to five timeouts to learn the same fact five times.
    reachabilityProbe ??= probeDaemon(options.socketPath());
    return await reachabilityProbe;
  };

  /**
   * Read only when the daemon does not answer, so a healthy daemon never pays for this file's
   * existence, and a running daemon's earlier crash is never mistaken for its current state.
   */
  const recordedFailure = (): DaemonStatus | null => {
    const path = options.statusPath();
    const status = path === null ? null : readDaemonStatus(path);
    return status?.state === 'failed' ? status : null;
  };

  /**
   * How long a recorded startup failure has been going on, and the remedy for it -- the part of
   * the answer that does not depend on which finding is reporting it. Shared by every place that
   * reports the record, so none of them can describe the same record a different way.
   */
  const note = (failure: DaemonStatus, lead: string): string => {
    const attempts = failure.attempts === 1 ? 'once' : `${String(failure.attempts)} times`;
    const next = failure.remediation === null
      ? 'Run `wtm daemon install` to start it again.'
      : `Run \`${formatRemediation(failure.remediation)}\`, then \`wtm daemon install\` to start it again.`;
    return [
      `${lead}: it failed to start ${attempts} since ${failure.since}.`,
      (failure.message ?? '').trim(),
      next,
    ].filter((part) => part !== '').join(' ');
  };

  const failureItem = async (): Promise<WtmError | null> => {
    if (await reachable()) return null;
    const failure = recordedFailure();
    if (failure === null) return null;
    // The record is a file on disk. Its code is only repeated as a code if it still is one.
    const code = wtmErrorCodeSchema.safeParse(failure.code);
    return {
      code: code.success ? code.data : 'WTM_DAEMON_UNAVAILABLE',
      message: note(failure, 'The daemon is not running'),
      severity: 'warning',
      context: {
        startupFailedSince: failure.since,
        startupAttempts: failure.attempts,
        startupPermanent: failure.permanent,
      },
      ...(failure.remediation === null
        ? {}
        : { remediation: [{ kind: 'command-suggestion' as const, argv: failure.remediation }] }),
    };
  };

  return { reachable, recordedFailure, note, failureItem };
}

function probeDaemon(socketPath: string | null): Promise<boolean> {
  return new Promise<boolean>((settle) => {
    // No platform, no address to dial. Reporting the daemon absent is the truthful answer: a host
    // WTM has no backend for has no daemon on it either, and `platform` says why.
    if (socketPath === null) {
      settle(false);
      return;
    }
    // Listeners before the connect, not after. Bun can report a missing socket file from inside
    // `createConnection` itself, before a listener attached on the next line exists, and an
    // `error` with nothing listening is a thrown exception. A machine with no daemon installed
    // is exactly the one whose socket file is missing (todo item 52).
    const socket = new Socket();
    let settled = false;
    const answer = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      settle(reachable);
    };
    // `on`, not `once`: the listener has to outlive the answer, or the `destroy` above can
    // raise an `error` event with nothing listening, which Node turns into a thrown exception.
    socket.on('error', () => answer(false));
    socket.setTimeout(daemonProbeTimeoutMs, () => answer(false));
    socket.once('connect', () => answer(true));
    try {
      socket.connect({ path: socketPath });
    } catch {
      // A path too long for an address raises synchronously; `socket-path` explains that one.
      answer(false);
      return;
    }
    socket.unref();
  });
}
