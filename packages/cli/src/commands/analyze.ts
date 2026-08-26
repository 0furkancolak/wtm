import { analyzeWorktree, type WorktreeAnalysis, type WorktreeContext } from '@wtm/core';
import type { JsonEnvelope } from '@wtm/protocol';
import { toGitSafetyError } from './git-error';

export type AnalyzeCommandInput = WorktreeContext;
export type AnalyzeCommandEnvelope = JsonEnvelope<WorktreeAnalysis | null>;

export async function runAnalyzeCommand(input: AnalyzeCommandInput): Promise<AnalyzeCommandEnvelope> {
  try {
    const analysis = await analyzeWorktree(input);
    return {
      schemaVersion: 1,
      ok: true,
      command: 'analyze',
      scope: {
        mode: 'local',
        ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      },
      data: analysis,
      warnings: [...analysis.safety.warnings],
      errors: [],
    };
  } catch (error) {
    return {
      schemaVersion: 1,
      ok: false,
      command: 'analyze',
      scope: {
        mode: 'local',
        ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      },
      data: null,
      warnings: [],
      errors: [toGitSafetyError(error, 'analyze')],
    };
  }
}
