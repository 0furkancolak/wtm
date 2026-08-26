import { spawn } from 'node:child_process';
import { parseGitWorktreePorcelain } from './worktree-parser.js';
import type { GitWorktreeRecord } from './worktree-parser.js';

export async function listGitWorktrees(repoPath: string): Promise<GitWorktreeRecord[]> {
  const output = await runGitWorktreeList(repoPath);
  return parseGitWorktreePorcelain(output);
}

function runGitWorktreeList(repoPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repoPath, 'worktree', 'list', '--porcelain', '-z'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
        return;
      }

      const detail = Buffer.concat(stderr).toString('utf8').trim();
      reject(new Error(`git worktree list failed (code ${code ?? 'none'}, signal ${signal ?? 'none'}): ${detail}`));
    });
  });
}

export type { GitWorktreeRecord } from './worktree-parser.js';
