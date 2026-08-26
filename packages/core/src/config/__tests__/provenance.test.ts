import { describe, expect, it } from 'bun:test';
import { findTomlValueLine } from '../provenance';

describe('findTomlValueLine', () => {
  it('returns a line only when the TOML leaf assignment can be identified reliably', () => {
    expect(findTomlValueLine('[tasks.dev]\nrun = ["make", "dev"]\n', 'tasks.dev.run')).toBe(2);
    expect(findTomlValueLine('[tasks.dev]\n# command lives elsewhere\n', 'tasks.dev.run')).toBeUndefined();
  });
});
