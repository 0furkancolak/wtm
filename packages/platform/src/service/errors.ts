/**
 * The single error type every service backend and the shared publisher raise.
 *
 * The class moved here from `packages/daemon/src/launchd.ts` unchanged in behaviour, because the
 * backend descriptors validate their own inputs — a label, an argument vector, a definition path —
 * and cannot import the daemon: `@wtm/platform` is below it in the dependency graph.
 *
 * **The codes still spell `LAUNCHD` on both platforms.** That is deliberate and it is temporary.
 * `packages/cli/src/commands/daemon.ts` maps exactly these strings onto the JSON envelope's error
 * codes, `docs/18-errors-json-contract.md` publishes them, and this task does not own either. A
 * systemd failure therefore reports `LAUNCHD_COMMAND_FAILED` today, which is wrong wording for a
 * right code — renaming it is a contract change that belongs with the CLI task that owns the
 * mapping and the document that publishes it, not to a refactor whose entire premise is that the
 * macOS behaviour is byte-identical afterwards.
 */
export type ServiceLifecycleErrorCode =
  | 'LAUNCHD_UNSUPPORTED_PLATFORM'
  | 'LAUNCHD_DOMAIN_UNAVAILABLE'
  | 'LAUNCHD_COMMAND_FAILED'
  | 'INVALID_LAUNCHD_CONFIGURATION'
  | 'UNSAFE_LAUNCHD_PATH'
  | 'LAUNCHD_ROLLBACK_FAILED'
  | 'LAUNCHD_ROLLBACK_CONFLICT'
  | 'LAUNCHD_OPERATION_BUSY'
  | 'LAUNCHD_TRANSACTION_INTERRUPTED';

export class ServiceLifecycleError extends Error {
  constructor(
    readonly code: ServiceLifecycleErrorCode,
    message: string,
    readonly context: Readonly<Record<string, string | number | boolean | null>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ServiceLifecycleError';
  }
}

export function configurationError(message: string): ServiceLifecycleError {
  return new ServiceLifecycleError('INVALID_LAUNCHD_CONFIGURATION', message);
}

export function pathError(message: string, cause: unknown): ServiceLifecycleError {
  return new ServiceLifecycleError('UNSAFE_LAUNCHD_PATH', message, {}, { cause });
}

export function transactionPathError(message: string, cause?: unknown): ServiceLifecycleError {
  return new ServiceLifecycleError('UNSAFE_LAUNCHD_PATH', message, {}, cause === undefined ? undefined : { cause });
}
