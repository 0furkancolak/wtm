import { describe, expect, it } from 'bun:test';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import type { ChecklistItemRecord, EndpointLease, ManagedProcessRecord, RepositoryRecord, WorktreeRecord } from '@wtm/core';
import {
  checklistApiHandler,
  devOverlayHtmlInjector,
  gatherDevOverlayData,
  injectBeforeBodyClose,
  isDevOverlayEnabledForRepo,
  isHtmlContentType,
  renderDevOverlayFragment,
  type DevOverlaySource,
} from '../dev-overlay';
import type { ProxyRoute } from '../proxy-routes';

function worktree(overrides: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return {
    id: 'worktree-1',
    repositoryId: 'repo-web',
    numericId: 1,
    path: '/repo/worktrees/auth',
    branch: 'feature/auth',
    headOid: 'deadbeef',
    isMain: false,
    isLocked: false,
    state: 'RUNNING',
    createdAt: '2026-09-21T09:00:00.000Z',
    lastSeenAt: '2026-09-21T09:00:00.000Z',
    lastRuntimeAt: null,
    ...overrides,
  };
}

function repository(overrides: Partial<RepositoryRecord> = {}): RepositoryRecord {
  return {
    id: 'repo-web',
    workspaceId: 'workspace-1',
    commonGitDir: '/repo/.git',
    mainRoot: '/home/dev/code/storefront-web',
    remoteIdentity: null,
    createdAt: '2026-09-21T09:00:00.000Z',
    lastReconciledAt: null,
    ...overrides,
  };
}

function lease(overrides: Partial<EndpointLease> = {}): EndpointLease {
  return {
    id: 'lease-1',
    worktreeId: 'worktree-1',
    name: 'web',
    protocol: 'tcp',
    host: '127.0.0.1',
    port: 23_671,
    state: 'ACTIVE',
    allocatedAt: '2026-09-21T09:00:00.000Z',
    lastVerifiedAt: '2026-09-21T09:00:00.000Z',
    ...overrides,
  };
}

function managedProcess(overrides: Partial<ManagedProcessRecord> = {}): ManagedProcessRecord {
  return {
    id: 'process-1',
    worktreeId: 'worktree-1',
    taskName: 'dev',
    pid: 4242,
    pgid: 4242,
    processStartTime: '2026-09-21T09:00:00.000Z',
    commandFingerprint: 'fp',
    state: 'RUNNING',
    startedAt: '2026-09-21T09:00:00.000Z',
    stoppedAt: null,
    stdoutPath: '/tmp/stdout.log',
    stderrPath: '/tmp/stderr.log',
    cleanupRequired: false,
    ...overrides,
  };
}

function checklistItem(overrides: Partial<ChecklistItemRecord> = {}): ChecklistItemRecord {
  return {
    worktreeId: 'worktree-1', position: 0, text: 'Check the login flow', checked: false,
    createdAt: '2026-09-21T09:00:00.000Z', updatedAt: '2026-09-21T09:00:00.000Z',
    ...overrides,
  };
}

function source(input: {
  worktrees: WorktreeRecord[];
  repositories?: RepositoryRecord[];
  leases: EndpointLease[];
  processes?: ManagedProcessRecord[];
  checklistItems?: ChecklistItemRecord[];
}): DevOverlaySource {
  return {
    listWorktrees: () => input.worktrees,
    listRepositories: () => input.repositories ?? [],
    listEndpointLeases: (query) => input.leases
      .filter((entry) => query?.states === undefined || query.states.includes(entry.state)),
    ...(input.processes === undefined ? {} : {
      listManagedProcesses: (query) => input.processes!.filter((entry) =>
        (query?.worktreeId === undefined || entry.worktreeId === query.worktreeId)
        && (query?.states === undefined || query.states.includes(entry.state))),
    }),
    ...(input.checklistItems === undefined ? {} : {
      listChecklistItems: (worktreeId) => input.checklistItems!.filter((entry) => entry.worktreeId === worktreeId),
    }),
  };
}

function currentRoute(overrides: Partial<ProxyRoute> = {}): ProxyRoute {
  return {
    hostname: 'web.feature-auth.wtm.localhost',
    host: '127.0.0.1',
    port: 23_671,
    worktreeId: 'worktree-1',
    service: 'web',
    ...overrides,
  };
}

describe('isHtmlContentType', () => {
  it('matches text/html', () => { expect(isHtmlContentType('text/html')).toBe(true); });
  it('matches text/html with a charset parameter', () => {
    expect(isHtmlContentType('text/html; charset=utf-8')).toBe(true);
  });
  it('is case-insensitive', () => { expect(isHtmlContentType('Text/HTML')).toBe(true); });
  it('rejects application/json', () => { expect(isHtmlContentType('application/json')).toBe(false); });
  it('rejects a missing header', () => { expect(isHtmlContentType(undefined)).toBe(false); });
  it('takes the first value of a duplicated header', () => {
    expect(isHtmlContentType(['text/html', 'text/plain'])).toBe(true);
  });
});

describe('injectBeforeBodyClose', () => {
  it('inserts the fragment immediately before </body>', () => {
    expect(injectBeforeBodyClose('<html><body>hi</body></html>', '<X/>'))
      .toBe('<html><body>hi<X/></body></html>');
  });

  it('matches </body> case-insensitively, as browsers tolerate', () => {
    expect(injectBeforeBodyClose('<html><BODY>hi</BODY></html>', '<X/>'))
      .toBe('<html><BODY>hi<X/></BODY></html>');
  });

  it('appends the fragment when there is no closing body tag', () => {
    expect(injectBeforeBodyClose('<html><body>hi', '<X/>')).toBe('<html><body>hi<X/>');
  });
});

describe('gatherDevOverlayData', () => {
  it('returns worktree identity and repo name derived the same way the CLI does (basename of mainRoot)', () => {
    const data = gatherDevOverlayData(
      source({ worktrees: [worktree()], repositories: [repository()], leases: [lease()] }),
      currentRoute(),
    );
    expect(data).not.toBeNull();
    expect(data?.repoName).toBe('storefront-web');
    expect(data?.branch).toBe('feature/auth');
    expect(data?.worktreeNumber).toBe(1);
    expect(data?.worktreePath).toBe('/repo/worktrees/auth');
    expect(data?.service).toBe('web');
    expect(data?.hostname).toBe('web.feature-auth.wtm.localhost');
  });

  it('returns null when the route names a worktree the store no longer has', () => {
    const data = gatherDevOverlayData(
      source({ worktrees: [], repositories: [], leases: [] }),
      currentRoute(),
    );
    expect(data).toBeNull();
  });

  it('falls back to the worktree\'s repositoryId when the repository record is missing', () => {
    const data = gatherDevOverlayData(
      source({ worktrees: [worktree()], repositories: [], leases: [lease()] }),
      currentRoute(),
    );
    expect(data?.repoName).toBe('repo-web');
  });

  it('lists this route itself as a "current" sibling alongside another service of the same worktree', () => {
    const data = gatherDevOverlayData(
      source({
        worktrees: [worktree()],
        repositories: [repository()],
        leases: [
          lease({ id: 'l1', name: 'web', port: 23_671 }),
          lease({ id: 'l2', name: 'api', port: 23_672 }),
        ],
      }),
      currentRoute(),
    );
    expect(data?.siblings).toHaveLength(2);
    const web = data?.siblings.find((entry) => entry.service === 'web');
    const api = data?.siblings.find((entry) => entry.service === 'api');
    expect(web?.current).toBe(true);
    expect(api?.current).toBe(false);
  });

  it('includes a sibling repository\'s endpoints when it is in the same workspace ("kardeş repolar dahil")', () => {
    const apiWorktree = worktree({ id: 'worktree-2', repositoryId: 'repo-api', branch: 'feature/auth' });
    const apiRepository = repository({ id: 'repo-api', workspaceId: 'workspace-1', mainRoot: '/home/dev/code/storefront-api' });
    const data = gatherDevOverlayData(
      source({
        worktrees: [worktree(), apiWorktree],
        repositories: [repository(), apiRepository],
        leases: [
          lease({ id: 'l1', worktreeId: 'worktree-1', name: 'web' }),
          lease({ id: 'l2', worktreeId: 'worktree-2', name: 'api', port: 23_680 }),
        ],
      }),
      currentRoute(),
    );
    expect(data?.siblings.map((entry) => entry.service).sort()).toEqual(['api', 'web']);
  });

  it('excludes a worktree in a different workspace entirely', () => {
    const otherWorktree = worktree({ id: 'worktree-2', repositoryId: 'repo-other', branch: 'feature/other' });
    const otherRepository = repository({ id: 'repo-other', workspaceId: 'workspace-2', mainRoot: '/home/dev/code/other' });
    const data = gatherDevOverlayData(
      source({
        worktrees: [worktree(), otherWorktree],
        repositories: [repository(), otherRepository],
        leases: [
          lease({ id: 'l1', worktreeId: 'worktree-1', name: 'web' }),
          lease({ id: 'l2', worktreeId: 'worktree-2', name: 'web', port: 23_680 }),
        ],
      }),
      currentRoute(),
    );
    expect(data?.siblings).toHaveLength(1);
    expect(data?.siblings[0]?.worktreeId).toBe('worktree-1');
  });

  it('excludes a worktree in the same workspace but a different feature branch — feature identity, not a workspace-wide scan', () => {
    const unrelatedWorktree = worktree({ id: 'worktree-2', repositoryId: 'repo-web', branch: 'feature/unrelated' });
    const data = gatherDevOverlayData(
      source({
        worktrees: [worktree(), unrelatedWorktree],
        repositories: [repository()],
        leases: [
          lease({ id: 'l1', worktreeId: 'worktree-1', name: 'web' }),
          lease({ id: 'l2', worktreeId: 'worktree-2', name: 'web', port: 23_680 }),
        ],
      }),
      currentRoute(),
    );
    expect(data?.siblings).toHaveLength(1);
    expect(data?.siblings[0]?.worktreeId).toBe('worktree-1');
  });

  it('a detached-HEAD worktree (branch null) is only ever a sibling of itself', () => {
    const detached = worktree({ branch: null });
    const otherDetached = worktree({ id: 'worktree-2', branch: null });
    const data = gatherDevOverlayData(
      source({
        worktrees: [detached, otherDetached],
        repositories: [repository()],
        leases: [
          lease({ id: 'l1', worktreeId: 'worktree-1', name: 'web' }),
          lease({ id: 'l2', worktreeId: 'worktree-2', name: 'web', port: 23_680 }),
        ],
      }),
      currentRoute(),
    );
    expect(data?.siblings).toHaveLength(1);
    expect(data?.siblings[0]?.worktreeId).toBe('worktree-1');
  });

  it('omits running tasks when the store does not offer listManagedProcesses', () => {
    const data = gatherDevOverlayData(
      source({ worktrees: [worktree()], repositories: [repository()], leases: [lease()] }),
      currentRoute(),
    );
    expect(data?.runningTasks).toEqual([]);
  });

  it('lists this worktree\'s RUNNING/STARTING managed processes when the store offers them', () => {
    const data = gatherDevOverlayData(
      source({
        worktrees: [worktree()],
        repositories: [repository()],
        leases: [lease()],
        processes: [
          managedProcess({ id: 'p1', taskName: 'dev', state: 'RUNNING' }),
          managedProcess({ id: 'p2', taskName: 'worker', state: 'STOPPED' }),
          managedProcess({ id: 'p3', taskName: 'db', worktreeId: 'some-other-worktree', state: 'RUNNING' }),
        ],
      }),
      currentRoute(),
    );
    expect(data?.runningTasks).toEqual([{ taskName: 'dev', state: 'RUNNING' }]);
  });

  it('omits the checklist when the store does not offer listChecklistItems', () => {
    const data = gatherDevOverlayData(
      source({ worktrees: [worktree()], repositories: [repository()], leases: [lease()] }),
      currentRoute(),
    );
    expect(data?.checklist).toEqual([]);
  });

  it('lists this worktree\'s checklist items (as the store returns them) when the store offers them', () => {
    const data = gatherDevOverlayData(
      source({
        worktrees: [worktree()],
        repositories: [repository()],
        leases: [lease()],
        checklistItems: [
          checklistItem({ position: 0, text: 'Check the login flow', checked: false }),
          checklistItem({ position: 1, text: 'Run the migration', checked: true }),
          checklistItem({ position: 0, text: 'Other worktree item', worktreeId: 'some-other-worktree' }),
        ],
      }),
      currentRoute(),
    );
    expect(data?.checklist).toEqual([
      { position: 0, text: 'Check the login flow', checked: false },
      { position: 1, text: 'Run the migration', checked: true },
    ]);
  });
});

describe('renderDevOverlayFragment', () => {
  const baseData = {
    repoName: 'storefront-web',
    branch: 'feature/auth',
    worktreeNumber: 3,
    worktreePath: '/repo/worktrees/auth',
    service: 'web',
    hostname: 'web.feature-auth.wtm.localhost',
    siblings: [],
    runningTasks: [],
    checklist: [],
  };

  it('renders the repo name, branch and worktree number', () => {
    const html = renderDevOverlayFragment(baseData);
    expect(html).toContain('storefront-web');
    expect(html).toContain('feature/auth');
    expect(html).toContain('worktree #3');
    expect(html).toContain('id="wtm-dev-overlay"');
  });

  it('shows "(detached)" for a null branch', () => {
    expect(renderDevOverlayFragment({ ...baseData, branch: null })).toContain('(detached)');
  });

  it('HTML-escapes a branch name containing markup, so it cannot break out of the fragment', () => {
    const html = renderDevOverlayFragment({ ...baseData, branch: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('links a sibling by its hostname and marks the current one without a link', () => {
    const html = renderDevOverlayFragment({
      ...baseData,
      siblings: [
        { hostname: 'web.feature-auth.wtm.localhost', service: 'web', worktreeId: 'worktree-1', current: true },
        { hostname: 'api.feature-auth.wtm.localhost', service: 'api', worktreeId: 'worktree-2', current: false },
      ],
    });
    expect(html).toContain('http://api.feature-auth.wtm.localhost');
    expect(html).toContain('this page');
  });

  it('renders no checkbox markup and no toggle script when the checklist is empty', () => {
    const html = renderDevOverlayFragment(baseData);
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('/__wtm/checklist');
    expect(html).not.toContain('<script>');
  });

  it('renders real checkboxes and the toggle script when the checklist has items', () => {
    const html = renderDevOverlayFragment({
      ...baseData,
      checklist: [
        { position: 0, text: 'Check the login flow', checked: false },
        { position: 1, text: 'Run the migration', checked: true },
      ],
    });
    expect(html).toContain('type="checkbox" data-position="0"');
    expect(html).not.toContain('type="checkbox" data-position="0" checked');
    expect(html).toContain('type="checkbox" data-position="1" checked');
    expect(html).toContain('Check the login flow');
    expect(html).toContain('Run the migration');
    expect(html).toContain('/__wtm/checklist');
    expect(html).toContain('<script>');
  });

  it('HTML-escapes checklist item text', () => {
    const html = renderDevOverlayFragment({
      ...baseData,
      checklist: [{ position: 0, text: '<script>alert(1)</script>', checked: false }],
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('checklistApiHandler', () => {
  function store(initial: ChecklistItemRecord[] = []) {
    const rows = new Map<string, ChecklistItemRecord>();
    for (const row of initial) rows.set(`${row.worktreeId}\u0000${row.position}`, row);
    return {
      list: (worktreeId: string) => [...rows.values()].filter((row) => row.worktreeId === worktreeId).sort((a, b) => a.position - b.position),
      set: () => { throw new Error('not used in these tests'); },
      clear: () => { throw new Error('not used in these tests'); },
      deleteForWorktree: () => { throw new Error('not used in these tests'); },
      setChecked: (worktreeId: string, position: number, checked: boolean, now: string) => {
        const key = `${worktreeId}\u0000${position}`;
        const row = rows.get(key);
        if (row === undefined) return null;
        const updated = { ...row, checked, updatedAt: now };
        rows.set(key, updated);
        return updated;
      },
    };
  }

  function fakeRequest(options: { method: string; url: string; body?: string }): IncomingMessage {
    const request = new Readable({
      read() {
        if (options.body !== undefined) this.push(options.body);
        this.push(null);
      },
    }) as unknown as IncomingMessage;
    request.method = options.method;
    request.url = options.url;
    return request;
  }

  it('GET returns the stored list', async () => {
    const handler = checklistApiHandler(store([checklistItem({ position: 0, text: 'Check it', checked: false })]));
    const result = await handler(currentRoute(), fakeRequest({ method: 'GET', url: '/__wtm/checklist' }));
    expect(result).toEqual({ status: 200, body: { items: [checklistItem({ position: 0, text: 'Check it', checked: false })] } });
  });

  it('POST toggles an item', async () => {
    const handler = checklistApiHandler(store([checklistItem({ position: 0, checked: false })]));
    const result = await handler(currentRoute(), fakeRequest({
      method: 'POST', url: '/__wtm/checklist', body: JSON.stringify({ position: 0, checked: true }),
    }));
    expect(result.status).toBe(200);
    expect((result.body as { item: ChecklistItemRecord }).item.checked).toBe(true);
  });

  it('POST with a malformed body is a 400', async () => {
    const handler = checklistApiHandler(store());
    const malformed = await handler(currentRoute(), fakeRequest({ method: 'POST', url: '/__wtm/checklist', body: 'not json' }));
    expect(malformed.status).toBe(400);
    const invalidShape = await handler(currentRoute(), fakeRequest({
      method: 'POST', url: '/__wtm/checklist', body: JSON.stringify({ position: 'zero', checked: true }),
    }));
    expect(invalidShape.status).toBe(400);
  });

  it('a request body over the size cap is a 413, not buffered without bound', async () => {
    // A real toggle body is `{position, checked}` — a few dozen bytes — so this stands in for any
    // caller that isn't the overlay's own fetch (the endpoint has no auth and lets a request with
    // no Origin header through by design, see `originMatchesHost`'s own comment in proxy.ts).
    const handler = checklistApiHandler(store());
    const oversized = 'x'.repeat(64 * 1024 + 1);
    const result = await handler(currentRoute(), fakeRequest({
      method: 'POST', url: '/__wtm/checklist', body: JSON.stringify({ position: 0, checked: true, note: oversized }),
    }));
    expect(result.status).toBe(413);
  });

  it('POST toggling a nonexistent position is a 404', async () => {
    const handler = checklistApiHandler(store());
    const result = await handler(currentRoute(), fakeRequest({
      method: 'POST', url: '/__wtm/checklist', body: JSON.stringify({ position: 5, checked: true }),
    }));
    expect(result).toEqual({ status: 404, body: { error: 'No checklist item at that position.' } });
  });

  it('any other method is a 405', async () => {
    const handler = checklistApiHandler(store());
    const result = await handler(currentRoute(), fakeRequest({ method: 'DELETE', url: '/__wtm/checklist' }));
    expect(result.status).toBe(405);
  });

  it('an unrecognized path under the prefix is a 405', async () => {
    const handler = checklistApiHandler(store());
    const result = await handler(currentRoute(), fakeRequest({ method: 'GET', url: '/__wtm/checklist/extra' }));
    expect(result.status).toBe(405);
  });
});

describe('devOverlayHtmlInjector', () => {
  it('returns a fragment for a known route and null for one the store no longer knows', () => {
    const injector = devOverlayHtmlInjector(
      source({ worktrees: [worktree()], repositories: [repository()], leases: [lease()] }),
      { enabled: true },
    );
    expect(injector(currentRoute())).toContain('storefront-web');
    expect(injector(currentRoute({ worktreeId: 'gone' }))).toBeNull();
  });

  it('lets a named repository opt out of an otherwise machine-wide overlay (todo item 46, repo-level toggle)', () => {
    const storeData = source({ worktrees: [worktree()], repositories: [repository()], leases: [lease()] });
    const optedOut = devOverlayHtmlInjector(storeData, { enabled: true, repos: { 'storefront-web': { enabled: false } } });
    expect(optedOut(currentRoute())).toBeNull();

    // An entry for a *different* name never touches this route.
    const otherNameDisabled = devOverlayHtmlInjector(storeData, { enabled: true, repos: { 'some-other-repo': { enabled: false } } });
    expect(otherNameDisabled(currentRoute())).toContain('storefront-web');
  });

  it('lets a named repository opt in when the table-level default is off', () => {
    const storeData = source({ worktrees: [worktree()], repositories: [repository()], leases: [lease()] });
    const optedIn = devOverlayHtmlInjector(storeData, { enabled: false, repos: { 'storefront-web': { enabled: true } } });
    expect(optedIn(currentRoute())).toContain('storefront-web');
  });

  it('falls back to the table-level default when a repository has an entry with no enabled value', () => {
    const storeData = source({ worktrees: [worktree()], repositories: [repository()], leases: [lease()] });
    const inertEntry = devOverlayHtmlInjector(storeData, { enabled: true, repos: { 'storefront-web': {} } });
    expect(inertEntry(currentRoute())).toContain('storefront-web');
  });
});

describe('isDevOverlayEnabledForRepo', () => {
  it('resolves default, override-off and override-on independently of other repositories', () => {
    const policy = { enabled: true, repos: { quiet: { enabled: false }, loud: { enabled: true } } };
    expect(isDevOverlayEnabledForRepo(policy, 'quiet')).toBe(false);
    expect(isDevOverlayEnabledForRepo(policy, 'loud')).toBe(true);
    expect(isDevOverlayEnabledForRepo(policy, 'unlisted')).toBe(true);
    expect(isDevOverlayEnabledForRepo({}, 'unlisted')).toBe(false);
  });
});
