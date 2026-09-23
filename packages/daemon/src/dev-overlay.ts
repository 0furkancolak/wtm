import type { IncomingMessage } from 'node:http';
import { basename } from 'node:path';
import type { ChecklistItemRecord, ChecklistStore, DevOverlayConfig, ManagedProcessRecord, ManagedProcessState, RepositoryRecord } from '@wtm/core';
import { checklistToggleRequestSchema } from '@wtm/protocol';
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
 * **2026-09-21, W11-1 (item 46b):** the agent-writes/user-checks test-step checklist this module's
 * header used to defer is implemented here too. `gatherDevOverlayData`/`renderDevOverlayFragment`
 * now also carry the checklist itself (real `<input type="checkbox">` markup, not the decorative
 * `<li>`s the sibling/task lists use), and `checklistApiHandler` below is the *other* half: the
 * proxy's own reserved-path HTTP API (`/__wtm/checklist`, wired in `proxy.ts`'s `overlayApi`
 * option) that the checkbox's own inline `<script>` POSTs to when the user toggles one, so the
 * state round-trips back into `ChecklistStore` without ever touching the Unix socket a browser
 * cannot reach. The checklist's own persisted record follows item 49's `task_overrides` pattern
 * (`packages/core/src/state/checklist.ts`/`checklist-store.ts`) rather than inventing a second
 * storage model, per item 46's own note.
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
  /**
   * Optional, for the same reason `listManagedProcesses` above is: nothing else in this module
   * requires a store to carry checklist items to be a valid `DevOverlaySource`, so a narrower test
   * double never has to implement it. Named distinctly from `ChecklistStore.list` (which this
   * simply forwards to) to avoid confusion between the store's own method and this source's.
   */
  listChecklistItems?(worktreeId: string): ChecklistItemRecord[];
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

/** One agent-written checklist step, shown as a real checkbox the user can toggle. */
export interface DevOverlayChecklistItem {
  position: number;
  text: string;
  checked: boolean;
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
  /** The worktree's dev-overlay checklist (todo item 46b, W11-1), in `position` order. */
  checklist: DevOverlayChecklistItem[];
}

const runningProcessStates: readonly ManagedProcessState[] = ['STARTING', 'RUNNING'];

/**
 * The repository-name identity `isDevOverlayEnabledForRepo` keys on, for one worktree alone —
 * the same derivation `gatherDevOverlayData` does as part of its larger gather, pulled out on its
 * own for a caller (`checklistApiHandler`) that needs only this, not the siblings/tasks/checklist
 * that come with a full gather. Null when the worktree has since disappeared.
 */
function repoNameForWorktree(store: Pick<DevOverlaySource, 'listRepositories' | 'listWorktrees'>, worktreeId: string): string | null {
  const worktree = store.listWorktrees().find((entry) => entry.id === worktreeId);
  if (worktree === undefined) return null;
  const repository = store.listRepositories().find((entry) => entry.id === worktree.repositoryId);
  return repository === undefined ? worktree.repositoryId : basename(repository.mainRoot);
}

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

  const checklist = store.listChecklistItems === undefined ? [] : store.listChecklistItems(worktree.id)
    .map((entry) => ({ position: entry.position, text: entry.text, checked: entry.checked }));

  return {
    repoName,
    branch: worktree.branch,
    worktreeNumber: worktree.numericId,
    worktreePath: worktree.path,
    service: route.service,
    hostname: route.hostname,
    siblings,
    runningTasks,
    checklist,
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
  // Real checkboxes, not the decorative `<li>`s the sibling/task lists use above: this is the one
  // part of the fragment the user actually acts on, so it needs a genuine `<input>` the toggle
  // script below can listen to and the browser can render as an interactive control. A route with
  // no checklist items renders neither this markup nor the script — zero added JS, same as before
  // this feature, matching the same "byte-identical when disabled" discipline the overlay's own
  // prod-non-leak test already established for the fragment as a whole.
  const checklistHtml = data.checklist.length === 0 ? '' : `<ul class="wtm-dev-overlay__list wtm-dev-overlay__checklist">${
    data.checklist.map((item) => `<li><label><input type="checkbox" data-position="${item.position}"${
      item.checked ? ' checked' : ''
    }> ${escapeHtml(item.text)}</label></li>`).join('')
  }</ul>
<script>
(function () {
  var root = document.getElementById('wtm-dev-overlay');
  if (!root) return;
  root.addEventListener('change', function (event) {
    var box = event.target;
    if (!box || box.tagName !== 'INPUT' || box.type !== 'checkbox' || !box.hasAttribute('data-position')) return;
    var position = Number(box.getAttribute('data-position'));
    var checked = box.checked;
    fetch('/__wtm/checklist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ position: position, checked: checked }),
    }).then(function (response) {
      if (!response.ok) box.checked = !checked;
    }).catch(function () {
      box.checked = !checked;
    });
  });
})();
</script>`;
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
#wtm-dev-overlay .wtm-dev-overlay__checklist label{cursor:pointer;display:flex;gap:4px;align-items:flex-start}
</style>
<details>
<summary title="${escapeHtml(data.worktreePath)}">WTM · ${escapeHtml(data.repoName)} · ${escapeHtml(branchLabel)}</summary>
<div class="wtm-dev-overlay__body">
<div>worktree #${data.worktreeNumber} · ${escapeHtml(data.service)}</div>
${siblingsHtml}
${tasksHtml}
${checklistHtml}
</div>
</details>
</div>`;
}

/**
 * Whether the overlay should render for a given repository name, given the table-level default
 * and this repository's own entry under `[dev-overlay.repos.<name>]` if it has one. A repository
 * with no entry simply falls back to the default; an entry present but with `enabled` unset does
 * the same (the entry exists only to eventually carry a value, not to imply a default of its own).
 */
export function isDevOverlayEnabledForRepo(policy: DevOverlayConfig, repoName: string): boolean {
  const override = policy.repos?.[repoName]?.enabled;
  return override ?? (policy.enabled ?? false);
}

/**
 * Builds the `ProxyServer` `htmlInjector` callback for the dev overlay: gathers this route's data
 * fresh (no caching, matching `buildProxyRoutes`'s own freshness contract) and renders it, or
 * returns `null` — which `proxy.ts` treats as "proxy this response untouched" — when there is
 * nothing to show, including when this route's repository was opted out of an otherwise-enabled
 * overlay via `[dev-overlay.repos.<name>].enabled = false` (todo item 46's "repo bazında kapatma").
 */
export function devOverlayHtmlInjector(store: DevOverlaySource, policy: DevOverlayConfig): (route: ProxyRoute) => string | null {
  return (route) => {
    const data = gatherDevOverlayData(store, route);
    if (data === null || !isDevOverlayEnabledForRepo(policy, data.repoName)) return null;
    return renderDevOverlayFragment(data);
  };
}

/** The exact reserved path the checklist toggle API answers on — see `proxy.ts`'s `overlayApi`. */
const checklistApiPath = '/__wtm/checklist';

/** The request path with any `?query` stripped, the same normalization `proxy.ts`'s own copy does. */
function pathnameOf(url: string | undefined): string {
  if (url === undefined) return '';
  const question = url.indexOf('?');
  return question === -1 ? url : url.slice(0, question);
}

/**
 * The largest checklist-toggle request body this endpoint accepts. A real body is
 * `{position, checked}` — a few dozen bytes — so this is generous headroom, not a working limit;
 * it exists only to bound what `readRequestBody` will buffer before `originMatchesHost` has even
 * run its course, since a request with no `Origin` header (deliberately let through, see that
 * function's own comment) reaches this from any local process with no size check otherwise.
 */
const maxChecklistRequestBytes = 64 * 1024;

class RequestBodyTooLarge extends Error {}

/** Buffers a small request body whole and returns it as a UTF-8 string, up to {@link maxChecklistRequestBytes}. */
function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxChecklistRequestBytes) {
        request.destroy();
        reject(new RequestBodyTooLarge(`Request body exceeded ${maxChecklistRequestBytes} bytes.`));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/**
 * Builds the `ProxyServer` `overlayApi` hook: the checklist's browser-facing toggle API (todo
 * item 46b, W11-1), served at the reserved path `/__wtm/checklist` and never forwarded to any
 * backend (see `proxy.ts`'s own doc comment on `overlayApi` for why this exists at all — the
 * browser can only ever reach this loopback proxy, never the daemon's Unix socket).
 *
 * `runtime-factory.ts` wires this in behind the same *aggregate* `devOverlayActive` check as
 * `devOverlayHtmlInjector`, because the two flags share one on/off switch at the daemon-startup
 * level. But `devOverlayHtmlInjector` re-checks `isDevOverlayEnabledForRepo` per request, inside
 * its own closure, so a repository that opted out via `[dev-overlay.repos.<name>].enabled = false`
 * never gets a rendered fragment even while the aggregate is `true` for some other repository on
 * the same (machine-wide) proxy. This handler needs the identical per-request re-check, or a
 * repository that opted out still has its checklist readable and toggleable by anyone who can
 * reach the shared loopback proxy, just with no visible overlay to toggle it from.
 *
 * - `GET` returns the worktree's stored checklist.
 * - `POST` with a `checklistToggleRequestSchema` body toggles one item by `position`; a position
 *   that no longer exists is a `404`, not a crash.
 * - A malformed or schema-invalid body is a `400`.
 * - Any other method, or any path under the prefix other than the bare `/__wtm/checklist` route
 *   itself, is a `405`.
 * - A route whose repository has opted out of the overlay is a `404`, matching how a disabled
 *   route already looks to `devOverlayHtmlInjector` (no fragment, nothing to toggle from).
 */
export function checklistApiHandler(
  store: ChecklistStore,
  routeSource: Pick<DevOverlaySource, 'listWorktrees' | 'listRepositories'>,
  policy: DevOverlayConfig,
): (route: ProxyRoute, request: IncomingMessage) => Promise<{ status: number; body: unknown }> {
  return async (route, request) => {
    const repoName = repoNameForWorktree(routeSource, route.worktreeId);
    if (repoName === null || !isDevOverlayEnabledForRepo(policy, repoName)) {
      return { status: 404, body: { error: 'No active WTM overlay for this route.' } };
    }
    if (pathnameOf(request.url) !== checklistApiPath) {
      return { status: 405, body: { error: 'Unrecognized path under /__wtm/checklist.' } };
    }
    if (request.method === 'GET') {
      return { status: 200, body: { items: store.list(route.worktreeId) } };
    }
    if (request.method !== 'POST') {
      return { status: 405, body: { error: 'Only GET and POST are supported on /__wtm/checklist.' } };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(await readRequestBody(request));
    } catch (error) {
      if (error instanceof RequestBodyTooLarge) return { status: 413, body: { error: error.message } };
      return { status: 400, body: { error: 'Request body is not valid JSON.' } };
    }
    const parsed = checklistToggleRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return { status: 400, body: { error: 'Request body must be { position: number, checked: boolean }.' } };
    }
    const record = store.setChecked(route.worktreeId, parsed.data.position, parsed.data.checked, new Date().toISOString());
    if (record === null) {
      return { status: 404, body: { error: 'No checklist item at that position.' } };
    }
    return { status: 200, body: { item: record } };
  };
}
