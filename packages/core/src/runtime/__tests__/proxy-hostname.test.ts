import { describe, expect, it } from 'bun:test';
import {
  assignProxySlugs,
  canonicalProxyHostname,
  isWtmProxyHostname,
  proxyHostname,
  slugifyBranchLabel,
  worktreeSlugSuffix,
  wtmLocalhostSuffix,
  type ProxyHostnameWorktree,
} from '../proxy-hostname';

describe('slugifyBranchLabel', () => {
  it('lowercases and keeps DNS-safe characters as-is', () => {
    expect(slugifyBranchLabel('feature/AUTH-42')).toBe('feature-auth-42');
  });

  it('collapses every other character to a single hyphen', () => {
    expect(slugifyBranchLabel('fix/auth_bug!!')).toBe('fix-auth-bug');
  });

  it('collapses repeated hyphens and trims the ends', () => {
    expect(slugifyBranchLabel('--release--2026.09--')).toBe('release-2026-09');
  });

  it('two differently-punctuated branches sanitize to the same label', () => {
    expect(slugifyBranchLabel('fix/auth-bug')).toBe(slugifyBranchLabel('fix-auth-bug'));
  });
});

function worktree(id: string, numericId: number, branch: string | null): ProxyHostnameWorktree {
  return { id, numericId, branch };
}

describe('assignProxySlugs', () => {
  it('gives each worktree its own sanitized branch slug when there is no collision', () => {
    const slugs = assignProxySlugs([
      worktree('a', 1, 'feature/auth'),
      worktree('b', 2, 'feature/billing'),
    ]);
    expect(slugs.get('a')).toBe('feature-auth');
    expect(slugs.get('b')).toBe('feature-billing');
  });

  it('strips the refs/heads/ prefix WorktreeRecord.branch actually carries', () => {
    const slugs = assignProxySlugs([worktree('a', 1, 'refs/heads/feature/auth')]);
    expect(slugs.get('a')).toBe('feature-auth');
  });

  it('the earliest worktree (lowest numericId) keeps the plain slug on collision', () => {
    const early = worktree('early', 1, 'fix/auth-bug');
    const late = worktree('late', 2, 'fix-auth-bug');
    const slugs = assignProxySlugs([late, early]);

    expect(slugs.get('early')).toBe('fix-auth-bug');
    expect(slugs.get('late')).toBe(`fix-auth-bug-${worktreeSlugSuffix('late')}`);
  });

  it('is stable across input order', () => {
    const early = worktree('early', 1, 'fix/auth-bug');
    const late = worktree('late', 2, 'fix-auth-bug');
    const forward = assignProxySlugs([early, late]);
    const backward = assignProxySlugs([late, early]);
    expect([...forward.entries()].sort()).toEqual([...backward.entries()].sort());
  });

  it('every member of a larger collision group gets a distinct slug', () => {
    const members = [
      worktree('w1', 3, 'fix/auth-bug'),
      worktree('w2', 1, 'fix-auth-bug'),
      worktree('w3', 2, 'fix--auth--bug'),
    ];
    const slugs = assignProxySlugs(members);
    const values = [...slugs.values()];
    expect(new Set(values).size).toBe(3);
    // w2 has the lowest numericId, so it keeps the plain slug.
    expect(slugs.get('w2')).toBe('fix-auth-bug');
  });

  it('falls back to the worktree id when the branch is null or sanitizes to nothing', () => {
    const detached = worktree('deadbeef-id', 1, null);
    const slugs = assignProxySlugs([detached]);
    expect(slugs.get('deadbeef-id')).toBe(slugifyBranchLabel('deadbeef-id'));
  });
});

describe('proxyHostname / canonicalProxyHostname', () => {
  it('builds <service>.<slug>.wtm.localhost', () => {
    expect(proxyHostname('web', 'auth')).toBe('web.auth.wtm.localhost');
    expect(proxyHostname('web', 'auth')).toBe(`web.auth.${wtmLocalhostSuffix}`);
  });

  it('canonicalProxyHostname resolves the same slug assignProxySlugs would for that worktree', () => {
    const early = worktree('early', 1, 'fix/auth-bug');
    const late = worktree('late', 2, 'fix-auth-bug');
    expect(canonicalProxyHostname(late, 'api', [early, late]))
      .toBe(`api.fix-auth-bug-${worktreeSlugSuffix('late')}.wtm.localhost`);
  });

  it('canonicalProxyHostname works when the worktree is not itself in the sibling list', () => {
    const only = worktree('only', 1, 'auth');
    expect(canonicalProxyHostname(only, 'web', [])).toBe('web.auth.wtm.localhost');
  });
});

describe('isWtmProxyHostname', () => {
  it('accepts a canonical hostname', () => {
    expect(isWtmProxyHostname('web.auth.wtm.localhost')).toBe(true);
  });

  it('rejects the bare suffix with nothing in front of it', () => {
    expect(isWtmProxyHostname('wtm.localhost')).toBe(false);
  });

  it('rejects an unrelated or forged host', () => {
    expect(isWtmProxyHostname('example.com')).toBe(false);
    // A label that merely ends in the letters "wtm.localhost" without the separating dot is not
    // a subdomain of wtm.localhost at all, and must not be treated as one.
    expect(isWtmProxyHostname('evil-wtm.localhost')).toBe(false);
    expect(isWtmProxyHostname('notwtm.localhost')).toBe(false);
  });
});
