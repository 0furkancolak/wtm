import { describe, expect, it } from 'bun:test';
import { parseWtmConfig } from '../schema';

describe('parseWtmConfig', () => {
  it('rejects a task which combines run with main or worktree commands', () => {
    expect(() => parseWtmConfig({ tasks: { dev: { run: ['make', 'dev'], main: ['make', 'main'] } } })).toThrow();
  });

  it('requires a string command to explicitly opt into shell execution', () => {
    expect(() => parseWtmConfig({ tasks: { legacy: { run: 'make dev' } } })).toThrow();
    expect(parseWtmConfig({ tasks: { legacy: { run: 'make dev', shell: true } } }).tasks?.legacy?.shell).toBe(true);
    expect(() => parseWtmConfig({ tasks: { safe: { run: ['make', 'dev'], shell: true } } })).toThrow();
  });

  it('validates every declared main and worktree command against shell mode', () => {
    expect(() => parseWtmConfig({ tasks: { dev: { main: ['make', 'dev'], worktree: 'make dev-worktree' } } })).toThrow();
    expect(() => parseWtmConfig({ tasks: { dev: { main: 'make dev', worktree: ['make', 'dev-worktree'], shell: true } } })).toThrow();
  });
});
