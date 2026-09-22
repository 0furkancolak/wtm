import { createHash } from 'node:crypto';

/**
 * Hostname naming for the local reverse proxy (todo item 12b).
 *
 * A canonical hostname is `<service>.<slug>.wtm.localhost`: `service` is the name an endpoint
 * lease already carries (`web`, `api`, ...; see `docs/07`'s "Endpoint leases" section), and
 * `slug` is a DNS-safe label derived from the worktree's `branch`. `.localhost` is reserved by
 * RFC 6761 to resolve to loopback for every resolver, and that reservation is not limited to the
 * bare label: section 6.3 says "users may assume that ... any domain name ending in
 * '.localhost' ... resolve[s] to the loopback address", which is what lets an arbitrarily deep
 * name like `web.auth.wtm.localhost` work with no `/etc/hosts` entry and no DNS server anywhere.
 * `wtm` is one extra label of our own so `*.wtm.localhost` cannot collide with a hostname a
 * repository's own tooling picks under plain `*.localhost`.
 */
export const wtmLocalhostSuffix = 'wtm.localhost';

/**
 * A worktree, reduced to what hostname assignment needs. `numericId` is WTM's own stable
 * ordinal (assigned once, at discovery, and never reused), which is what makes collision
 * disambiguation deterministic across a daemon restart: it does not depend on iteration order,
 * on wall-clock time, or on which worktree a particular process happened to see first.
 */
export interface ProxyHostnameWorktree {
  id: string;
  numericId: number;
  branch: string | null;
}

/**
 * Sanitizes an arbitrary branch name into a DNS-safe label: lowercase, `[a-z0-9-]` only, every
 * other character collapsed to `-`, repeated `-` collapsed to one, leading/trailing `-` trimmed.
 *
 * `fix/auth-bug` and `fix-auth-bug` both become `fix-auth-bug` this way, which is exactly the
 * collision `assignProxySlugs` is written to disambiguate rather than to prevent.
 */
export function slugifyBranchLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The deterministic disambiguator appended to a colliding slug: the first 6 hex characters of
 * `sha256(worktreeId)`. Short enough to keep the hostname readable, and long enough (24 bits)
 * that two worktrees of the same workspace colliding on both their branch slug *and* this suffix
 * is not a case worth engineering for.
 */
export function worktreeSlugSuffix(worktreeId: string): string {
  return createHash('sha256').update(worktreeId).digest('hex').slice(0, 6);
}

/**
 * Assigns each worktree a DNS-safe, deterministic slug, stable across daemon restarts because it
 * is derived only from data the worktree record itself already carries.
 *
 * The base slug is `slugifyBranchLabel(branch)`, falling back to the worktree's own id when the
 * branch is absent (detached HEAD) or sanitizes to nothing. When two or more worktrees share a
 * base slug, the member with the lowest `numericId` — the one WTM has held longest — keeps the
 * plain slug, and every other member appends `-<worktreeSlugSuffix>`. This is what the "WTM
 * registry collision check" language in `docs/07`'s endpoint-lease section is mirrored by: the
 * earliest worktree's hostname does not change just because a later branch happens to sanitize
 * the same way, so a bookmarked URL for it stays valid.
 */
export function assignProxySlugs(worktrees: readonly ProxyHostnameWorktree[]): ReadonlyMap<string, string> {
  const groups = new Map<string, ProxyHostnameWorktree[]>();
  for (const worktree of worktrees) {
    const base = baseSlug(worktree);
    const group = groups.get(base);
    if (group === undefined) groups.set(base, [worktree]);
    else group.push(worktree);
  }

  const slugs = new Map<string, string>();
  for (const [base, group] of groups) {
    if (group.length === 1) {
      slugs.set((group[0] as ProxyHostnameWorktree).id, base);
      continue;
    }
    const ordered = [...group].sort((a, b) => a.numericId - b.numericId);
    for (const [index, worktree] of ordered.entries()) {
      slugs.set(worktree.id, index === 0 ? base : `${base}-${worktreeSlugSuffix(worktree.id)}`);
    }
  }
  return slugs;
}

/**
 * `WorktreeRecord.branch` (as `worktree-parser.ts` reads it straight from
 * `git worktree list --porcelain`'s `branch` field) is the full ref, `refs/heads/<name>`, not
 * the short name — the same fact `create-worktree.ts` already strips this same prefix for. A
 * short branch label is what a person recognizes in a hostname, so this strips it before
 * slugifying rather than leaving `refs-heads-` baked into every worktree's slug.
 */
function shortBranchName(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

function baseSlug(worktree: ProxyHostnameWorktree): string {
  const fromBranch = worktree.branch === null ? '' : slugifyBranchLabel(shortBranchName(worktree.branch));
  if (fromBranch !== '') return fromBranch;
  const fromId = slugifyBranchLabel(worktree.id);
  return fromId !== '' ? fromId : 'worktree';
}

/**
 * The canonical hostname for one service of one already-slugged worktree.
 *
 * `service` is lowercased: it comes straight from a `[ports.<name>]` TOML key with no case
 * normalization of its own (`endpoint-plan.ts` reads it via a plain `Object.entries`), while
 * every incoming Host header is lowercased before a route lookup (`hostnameFromHeader` in
 * `packages/daemon/src/proxy.ts`) because URL host components are ASCII-lowercased by every
 * standards-compliant client. A hostname built from an unlowercased `[ports.API]` would register
 * a route no real request could ever match.
 */
export function proxyHostname(service: string, slug: string): string {
  return `${service.toLowerCase()}.${slug}.${wtmLocalhostSuffix}`;
}

/**
 * The canonical hostname for one (worktree, service) pair, resolved against every worktree that
 * shares its collision group.
 *
 * A one-shot convenience over `assignProxySlugs`/`proxyHostname` for a caller that has a single
 * pair in hand — a future `wtm status`/`wtm ports` line, or a CORS-integration unit — and does
 * not want to re-derive the slugging rule itself. A caller computing hostnames for many
 * worktrees at once (the proxy's own routing table) should call `assignProxySlugs` once instead:
 * this recomputes the whole collision group on every call.
 */
export function canonicalProxyHostname(
  worktree: ProxyHostnameWorktree,
  service: string,
  siblingWorktrees: readonly ProxyHostnameWorktree[],
): string {
  const slugs = assignProxySlugs(siblingWorktrees.some((entry) => entry.id === worktree.id)
    ? siblingWorktrees
    : [...siblingWorktrees, worktree]);
  const slug = slugs.get(worktree.id) ?? baseSlug(worktree);
  return proxyHostname(service, slug);
}

/** True when `hostname` ends in `.wtm.localhost` and therefore names at least one label before it. */
export function isWtmProxyHostname(hostname: string): boolean {
  const suffix = `.${wtmLocalhostSuffix}`;
  return hostname.length > suffix.length && hostname.endsWith(suffix);
}
