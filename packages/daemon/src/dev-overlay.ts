import { basename } from 'node:path';
import type { ManagedProcessRecord, ManagedProcessState, RepositoryRecord } from '@wtm/core';
import { buildProxyRoutes, type ProxyRoute, type ProxyRouteSource } from './proxy-routes';

/**
 * The dev overlay (todo item 46, W10-4 MVP slice): a small HTML fragment the local reverse proxy
 * injects into a proxied `text/html` response, so a developer looking at a running dev server can
 * tell, from the page itself, which worktree/branch/service they are looking at, and jump to a
 * sibling service without hunting through terminals for a port number.
 *
 * This module is the injection mechanism's *data and rendering* half; `proxy.ts` owns *where*
 * injection happens in the response-handling path — decision 1 in the W10-4 plan: the proxy is
 * the single injection point (resolving todo item 46's own "enjeksiyon katmanı" decision bullet
 * via K10), not a per-framework adapter. See `docs/07`'s "Local reverse proxy" section.
 *
 * Deliberately narrow, per decision 4: no new schema or contract parallel to `wtm status
 * --json`'s shape (`packages/cli/src/diagnostics.ts`'s `StatusDiagnostic`). This reads the same
 * state-store queries the proxy's own routing table already reads (`listWorktrees`,
 * `listEndpointLeases`, via `buildProxyRoutes`), plus `listRepositories` for a human-readable
 * repository name (the same `basename(mainRoot)` convention `packages/cli/src/worktree-
 * selector.ts` already uses) and the optional `listManagedProcesses` for a read-only "currently
 * supervised" task list — trivially available from a query the daemon already exposes elsewhere
 * (`wtm status`'s own `processes` section reads the same store method), so it is included; no new
 * plumbing was added for it.
 *
 * Out of scope for this slice, and NOT implemented here: the agent-writes/user-checks test-step
 * checklist todo item 46 also describes. That needs its own persisted record and a two-way wire
 * protocol comparable in size to the task-record surface todo item 49 defines, and item 46's own
 * text says the checklist should live there rather than invent a second store — so it stays
 * future work. See todo.md item 46's own note for the deferral.
 */

/**
 * What the overlay's data gathering needs from the state store, beyond `ProxyRouteSource`
 * (which it also uses, via `buildProxyRoutes`, for the sibling-endpoint list).
 */
export interface DevOverlaySource extends ProxyRouteSource {
  listRepositories(workspaceId?: string): RepositoryRecord[];
  /**
   * Optional: when the store offers it, the overlay also lists this worktree's currently
   * supervised processes. Left optional because nothing else in this module requires a store to
   * carry process records to be a valid `DevOverlaySource` — omitting it simply omits that list.
   */
  listManagedProcesses?(query?: {
    worktreeId?: string;
    states?: readonly ManagedProcessState[];
  }): ManagedProcessRecord[];
}

/** One other endpoint reachable through the same proxy, for the same feature. */
export interface DevOverlaySibling {
  hostname: string;
  service: string;
  worktreeId: string;
  /** True for the endpoint the current request actually reached — shown, never linked to itself. */
  current: boolean;
}

/** One managed process the daemon currently supervises for this worktree. */
export interface DevOverlayRunningTask {
  taskName: string;
  state: ManagedProcessState;
}

export interface DevOverlayData {
  repoName: string;
  branch: string | null;
  worktreeNumber: number;
  worktreePath: string;
  service: string;
  hostname: string;
  /** Every active proxy endpoint for the same workspace, including this one (`current: true`). */
  siblings: DevOverlaySibling[];
  runningTasks: DevOverlayRunningTask[];
}

const runningProcessStates: readonly ManagedProcessState[] = ['STARTING', 'RUNNING'];

/**
 * Gathers what the overlay shows for one proxied route, straight from state-store queries the
 * daemon already runs elsewhere — see this module's own doc comment for which ones and why no
 * new persistence is involved. Returns `null` when the route's worktree has since disappeared
 * (removed between the request being routed and this call): there is nothing honest to show, and
 * the caller falls back to injecting nothing rather than a stale identity.
 */
export function gatherDevOverlayData(store: DevOverlaySource, route: ProxyRoute): DevOverlayData | null {
  const worktree = store.listWorktrees().find((entry) => entry.id === route.worktreeId);
  if (worktree === undefined) return null;

  const repositories = store.listRepositories();
  const repository = repositories.find((entry) => entry.id === worktree.repositoryId);
  const repoName = repository === undefined ? worktree.repositoryId : basename(repository.mainRoot);

  // Sibling endpoints: every active proxy route belonging to a worktree in the same *workspace*
  // that was also cut from the same *branch* — not just this worktree's own services, and not
  // every worktree the workspace has ever held. `FeatureRecord` (`store.ts`) is exactly this
  // identity, keyed by `(workspaceId, branch)`, so matching on the branch a worktree already
  // carries is feature identity, the way todo item 46's own "feature identity üzerinden çözülsün,
  // port taramasıyla değil" line asks — not a scan of open ports, and not every worktree the
  // workspace has ever held for unrelated features. A worktree with no branch (detached `HEAD`)
  // has no feature identity to share, so it is only ever a sibling of itself.
  const workspaceRepositoryIds = repository === undefined
    ? new Set([worktree.repositoryId])
    : new Set(repositories.filter((entry) => entry.workspaceId === repository.workspaceId).map((entry) => entry.id));
  const siblingWorktreeIds = new Set(
    worktree.branch === null
      ? [worktree.id]
      : store.listWorktrees()
        .filter((entry) => workspaceRepositoryIds.has(entry.repositoryId) && entry.branch === worktree.branch)
        .map((entry) => entry.id),
  );
  const siblings = [...buildProxyRoutes(store).values()]
    .filter((candidate) => siblingWorktreeIds.has(candidate.worktreeId))
    .map((candidate) => ({
      hostname: candidate.hostname,
      service: candidate.service,
      worktreeId: candidate.worktreeId,
      current: candidate.hostname === route.hostname,
    }))
    .sort((left, right) => left.hostname.localeCompare(right.hostname));

  const runningTasks = store.listManagedProcesses === undefined ? [] : store.listManagedProcesses({
    worktreeId: worktree.id,
    states: runningProcessStates,
  }).map((entry) => ({ taskName: entry.taskName, state: entry.state }))
    .sort((left, right) => left.taskName.localeCompare(right.taskName));

  return {
    repoName,
    branch: worktree.branch,
    worktreeNumber: worktree.numericId,
    worktreePath: worktree.path,
    service: route.service,
    hostname: route.hostname,
    siblings,
    runningTasks,
  };
}

/**
 * Whether a backend response's `content-type` header names an HTML document, ignoring parameters
 * such as `; charset=utf-8`. This is decision 2's whole gate: only a `true` result here ever
 * reaches the injector, and everything else is proxied byte-for-byte untouched.
 */
export function isHtmlContentType(contentType: string | string[] | undefined): boolean {
  const value = Array.isArray(contentType) ? contentType[0] : contentType;
  if (typeof value !== 'string') return false;
  const mediaType = value.split(';')[0]?.trim().toLowerCase();
  return mediaType === 'text/html';
}

/**
 * Inserts a fragment right before the first `</body>` (case-insensitive, matching how browsers
 * themselves tolerate the closing tag), or appends it when the document has none — a fragment
 * response or a malformed document still gets the overlay rather than silently losing it.
 */
export function injectBeforeBodyClose(html: string, fragment: string): string {
  const match = /<\/body\s*>/i.exec(html);
  if (match === null) return html + fragment;
  return html.slice(0, match.index) + fragment + html.slice(match.index);
}

const escapeTable: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => escapeTable[char] as string);
}

/**
 * Renders the overlay's own inline markup: one `<style>` block and one small, closed-by-default
 * `<details>` element — no separate JS bundle, no build step, no external asset requests (decision
 * 5). A native `<details>`/`<summary>` disclosure needs no script to open or close, which is what
 * keeps this a plain fragment rather than something that needs its own bundling story. Every
 * dynamic value is HTML-escaped; nothing here trusts branch names, repository paths or task names
 * to be free of `<`/`&`.
 */
export function renderDevOverlayFragment(data: DevOverlayData): string {
  const branchLabel = data.branch === null ? '(detached)' : data.branch;
  const siblingsHtml = data.siblings.length === 0 ? '' : `<ul class="wtm-dev-overlay__list">${
    data.siblings.map((sibling) => (sibling.current
      ? `<li class="wtm-dev-overlay__current">${escapeHtml(sibling.service)} (this page)</li>`
      : `<li><a href="http://${escapeHtml(sibling.hostname)}" target="_blank" rel="noopener noreferrer">${escapeHtml(sibling.service)}</a></li>`
    )).join('')
  }</ul>`;
  const tasksHtml = data.runningTasks.length === 0 ? '' : `<ul class="wtm-dev-overlay__list">${
    data.runningTasks.map((task) =>
      `<li>${escapeHtml(task.taskName)} · ${escapeHtml(task.state.toLowerCase())}</li>`).join('')
  }</ul>`;
  return `
<div id="wtm-dev-overlay">
<style>
#wtm-dev-overlay{position:fixed;right:8px;bottom:8px;z-index:999999;font:12px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e6e6e6;background:#1c1c1ecc;border:1px solid #3a3a3a;border-radius:6px;max-width:280px;box-shadow:0 2px 8px rgba(0,0,0,.35)}
#wtm-dev-overlay summary{cursor:pointer;padding:6px 10px;list-style:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#wtm-dev-overlay summary::-webkit-details-marker{display:none}
#wtm-dev-overlay .wtm-dev-overlay__body{padding:0 10px 8px;border-top:1px solid #3a3a3a}
#wtm-dev-overlay .wtm-dev-overlay__list{list-style:none;margin:4px 0;padding:0}
#wtm-dev-overlay .wtm-dev-overlay__list li{padding:2px 0}
#wtm-dev-overlay a{color:#7ab8ff;text-decoration:none}
#wtm-dev-overlay a:hover{text-decoration:underline}
#wtm-dev-overlay .wtm-dev-overlay__current{color:#8f8f8f}
</style>
<details>
<summary title="${escapeHtml(data.worktreePath)}">WTM · ${escapeHtml(data.repoName)} · ${escapeHtml(branchLabel)}</summary>
<div class="wtm-dev-overlay__body">
<div>worktree #${data.worktreeNumber} · ${escapeHtml(data.service)}</div>
${siblingsHtml}
${tasksHtml}
</div>
</details>
</div>`;
}

/**
 * Builds the `ProxyServer` `htmlInjector` callback for the dev overlay: gathers this route's data
 * fresh (no caching, matching `buildProxyRoutes`'s own freshness contract) and renders it, or
 * returns `null` — which `proxy.ts` treats as "proxy this response untouched" — when there is
 * nothing to show.
 */
export function devOverlayHtmlInjector(store: DevOverlaySource): (route: ProxyRoute) => string | null {
  return (route) => {
    const data = gatherDevOverlayData(store, route);
    return data === null ? null : renderDevOverlayFragment(data);
  };
}
