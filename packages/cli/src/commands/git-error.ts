import {
  GitCommandError,
  WorktreeAnalysisError,
} from '@wtm/core';
import { wtmErrorCodeSchema } from '@wtm/protocol';
import type { Remediation, WtmError, WtmErrorCode } from '@wtm/protocol';

export function toGitSafetyError(error: unknown, command: string): WtmError {
  if (error instanceof GitCommandError) {
    return {
      code: 'GIT_COMMAND_FAILED',
      message: error.message,
      severity: 'error',
      context: {
        command,
        argv: [...error.argv],
        exitCode: error.exitCode,
        signal: error.signal,
        stderr: error.stderr,
      },
    };
  }
  if (error instanceof WorktreeAnalysisError) {
    return {
      code: error.code,
      message: error.message,
      severity: 'error',
      context: { ...error.context, command },
    };
  }
  if (hasErrorCode(error)) {
    return {
      code: error.code,
      message: error instanceof Error ? error.message : 'Git safety operation failed.',
      severity: 'error',
      context: { ...readContext(error), command },
      // A refusal that knows what to do next carries it. Dropping the remediation here is how
      // `--resume` stopped being discoverable from the message that exists to suggest it.
      ...readRemediation(error),
    };
  }
  return {
    code: 'GIT_REPOSITORY_DEGRADED',
    message: error instanceof Error ? error.message.slice(0, 4096) : 'Git safety operation failed.',
    severity: 'error',
    context: { command },
  };
}

function hasErrorCode(error: unknown): error is { code: WtmErrorCode } {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return typeof error.code === 'string' && knownCodes.has(error.code as WtmErrorCode);
}

/** Only well-formed suggestions survive; a malformed one must not fail envelope validation. */
function readRemediation(error: object): { remediation?: Remediation[] } {
  if (!('remediation' in error) || !Array.isArray(error.remediation)) return {};
  const remediation = error.remediation.filter(isCommandSuggestion);
  return remediation.length === 0 ? {} : { remediation };
}

function isCommandSuggestion(value: unknown): value is Remediation {
  if (!isRecord(value) || value['kind'] !== 'command-suggestion') return false;
  const argv = value['argv'];
  return Array.isArray(argv) && argv.length > 0 && argv.every((word) => typeof word === 'string');
}

function readContext(error: object): Record<string, unknown> {
  return 'context' in error && isRecord(error.context) ? error.context : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The catalogue is `wtmErrorCodeSchema`, so this reads it rather than restating it. The literal list
 * that used to stand here was a third copy of the codes, held to the schema by nothing: a code the
 * schema gained and this file did not fell through `hasErrorCode` and was reported as
 * `GIT_REPOSITORY_DEGRADED`, discarding the exit code the caller was owed. Four codes had already
 * drifted that way before anyone noticed.
 */
const knownCodes: ReadonlySet<WtmErrorCode> = new Set(wtmErrorCodeSchema.options);
