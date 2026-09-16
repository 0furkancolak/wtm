/**
 * One long-lived `powershell.exe` reused across ACL calls, instead of a cold process per call.
 *
 * A cold Windows PowerShell start plus the `Microsoft.PowerShell.Security` import costs on the
 * order of a second (measured on a real `windows-latest` runner, see `windows-powershell.ts`).
 * `packages/daemon/src/__tests__/logs.test.ts` *passes* on the win32 CI leg while burning more
 * than ten minutes of a twenty-five minute budget on nothing else, which is why 111 of 218 test
 * files never ran; `.github/workflows/ci.yml` names a pooled session as the actual answer.
 *
 * The trust answer must not get weaker for being faster. Four properties carry that:
 *
 * 1. **A dead session is a refusal, never a "trusted".** Every settlement path other than a
 *    matched, well-formed response frame rejects. `createWindowsAclReader` turns a rejection into
 *    `undefined` and the policy turns `undefined` into `false`, so a crashed, killed or timed-out
 *    session denies exactly the way a failed `execFile` denied before.
 * 2. **What the reuse does and does not confine.** Invoking each request as `& <ScriptBlock>`
 *    gives it its own scope, which confines its *implicit* assignments — and only those. A script
 *    that wrote `$global:x`, `Set-Variable -Scope Global`, a global function or alias, `$env:*`,
 *    `$PSDefaultParameterValues`, a type accelerator, `Update-FormatData` or `New-PSDrive -Scope
 *    Global` would outlive its request, and `Import-Module` of an already-loaded module would not
 *    undo it. None of that is reachable: the only scripts that ever run here are the two this
 *    package composes, and no caller-controlled text reaches PowerShell as source (property 3).
 *    What the wrapper *does* guarantee against accidental drift is the two settings a failure
 *    would silently ride on — `$ErrorActionPreference` and the working directory are
 *    re-established before every request — and every command named anywhere this session
 *    executes, in the prologue, in the wrapper and in both request scripts, is module-qualified
 *    (`Microsoft.PowerShell.Security\Get-Acl`, `Microsoft.PowerShell.Management\Set-Location`,
 *    `Microsoft.PowerShell.Core\ForEach-Object`, ...), so a shadowing function or alias cannot
 *    intercept one. `ForEach-Object` earns that as much as `Get-Acl` does: it is what renders the
 *    script's output before `[string]::Join` sees it, so hijacking it would rewrite an answer
 *    rather than refuse one. That qualification is the load-bearing part: almost every escape above fails
 *    *closed* (a broken preference or a hijacked `ConvertTo-Json` throws, which is a refusal),
 *    but a shadowed `Get-Acl` or a remapped `[PSCustomObject]` accelerator could hand back a
 *    forged reading, which is the one shape that would be a wrong "trusted" rather than a wrong
 *    "untrusted". The session is started `-NoProfile` `-NonInteractive` and never runs a script
 *    *file*, so execution policy has nothing to govern.
 * 3. **No caller data is ever script text.** The request script is base64-encoded into the
 *    wrapper and the path is base64-encoded into the request script (`windows-powershell.ts`), so
 *    a path containing quotes, `$(...)`, backticks or newlines travels as `[A-Za-z0-9+/=]` and is
 *    reconstructed as data. A long-lived session raises the value of an injection, so the only
 *    safe design is one where no interpolation exists to attack.
 * 4. **Everything is bounded.** Per-request execution deadline, per-request *queue* deadline, a
 *    maximum queue depth, a maximum session lifetime and a maximum number of requests per
 *    session, plus an idle deadline after which the process exits. A session that wedges rejects
 *    its work and is replaced — including the wedged-but-*alive* case, where an interpreter keeps
 *    answering and every answer fails inside the wrapper: a run of consecutive *wrapper* failures
 *    retires it, so the next caller meets a fresh interpreter instead of a bad one that cannot die
 *    on its own. A failed *script* is not that and is not counted: a path whose ACL cannot be read
 *    is an ordinary answer, and recycling a healthy interpreter over one would reintroduce the
 *    cold start this file exists to remove.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { PowershellRunner } from './windows-powershell';

/** The pieces of a child process this module actually uses; a test fake supplies the same shape. */
export interface PowershellChild {
  readonly stdin: { write(chunk: string): unknown; on(event: string, listener: (value: never) => void): unknown; unref?(): unknown };
  readonly stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown; unref?(): unknown };
  readonly stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown; unref?(): unknown };
  on(event: string, listener: (...values: never[]) => void): unknown;
  once(event: string, listener: (...values: never[]) => void): unknown;
  kill(signal?: string): unknown;
  unref?(): unknown;
}

export type PowershellSpawn = (file: string, args: readonly string[], options: Record<string, unknown>) => PowershellChild;

export interface PowershellSessionOptions {
  /** Test seam; production always starts a real `powershell.exe`. */
  readonly spawn?: PowershellSpawn;
  /** How long one request may run once it owns the session. */
  readonly requestTimeoutMs?: number;
  /** How long one request may wait for its turn before it is refused rather than queued forever. */
  readonly queueTimeoutMs?: number;
  /** How long an idle session stays alive before its process exits. */
  readonly idleTimeoutMs?: number;
  /** Upper bound on one session process's wall-clock life, enforced between requests. */
  readonly maxLifetimeMs?: number;
  /** Upper bound on requests served by one session process, enforced between requests. */
  readonly maxRequests?: number;
  /** Upper bound on requests waiting for a turn. */
  readonly maxQueued?: number;
  /** Upper bound on bytes one request may produce before it is failed and the session replaced. */
  readonly maxResponseBytes?: number;
  /**
   * How many consecutive *wrapper* failures retire an interpreter that is still alive and still
   * answering. Script failures -- an ACL that could not be read -- deliberately do not count:
   * they are statements about a path, not about the interpreter.
   */
  readonly maxConsecutiveFailures?: number;
  readonly now?: () => number;
}

export interface PowershellSession {
  /** Resolves the script's stdout, or rejects. It never resolves on a session that died. */
  run(script: string): Promise<string>;
  /** Ends the current process and refuses everything queued. */
  close(): void;
}

const defaults = {
  requestTimeoutMs: 15_000,
  queueTimeoutMs: 30_000,
  idleTimeoutMs: 30_000,
  maxLifetimeMs: 300_000,
  maxRequests: 500,
  maxQueued: 64,
  maxResponseBytes: 4 * 1024 * 1024,
  maxConsecutiveFailures: 3,
};

/**
 * Sent once per process. Each statement stands alone, so `-Command -` can execute them as it
 * reads.
 *
 * A failure here must not be able to wedge the session. The security-module import is harmless to
 * lose, because every request script imports it by the same literal path anyway. `$WtmOrigin` is
 * the one that could bite: if this line never ran, or yielded `$null`, an unguarded
 * `Set-Location -LiteralPath $WtmOrigin` would throw inside *every* later request's wrapper and
 * turn the whole session into a refusal machine. `frame` therefore restores the location only
 * when there is one to restore, and a run of consecutive failures retires the interpreter.
 */
const prologue: readonly string[] = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  'Microsoft.PowerShell.Core\\Import-Module -Name "$PSHOME\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1"',
  '$WtmOrigin = (Microsoft.PowerShell.Management\\Get-Location).Path',
];

/**
 * One line, whatever the script contains: the script is data inside it, never source.
 *
 * The script's output is joined with `[string]::Join`, not rendered with `Out-String`, on purpose.
 * `Out-String` formats for a console and *wraps* at its width, which would silently corrupt a
 * long `ConvertTo-Json -Compress` line — the one thing this transport must never do. Joining the
 * emitted strings reproduces exactly what `execFile` used to capture on stdout.
 */
function frame(script: string, token: string): string {
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  return [
    "$WtmOut = ''",
    "$WtmOk = '2'",
    '$WtmBlock = $null',
    // Everything the *wrapper* owns, in its own `try`. A failure here is a property of the
    // interpreter, not of the path being asked about, so it reports `2` and counts toward the
    // breaker. Decoding the script lives in here too: outside a `try` it would emit no frame at
    // all and cost a caller the full request deadline before anything noticed.
    "try { $ErrorActionPreference = 'Stop';"
      + ' if ($null -ne $WtmOrigin) { Microsoft.PowerShell.Management\\Set-Location -LiteralPath $WtmOrigin };'
      + ` $WtmBlock = [ScriptBlock]::Create([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))) }`
      + " catch { $WtmOk = '2'; $WtmBlock = $null }",
    // The script itself. Its failure reports `0` and is an ordinary refusal about one path, not
    // evidence about the interpreter -- `Get-Acl` under `Stop` throws `ItemNotFoundException` for
    // a path renamed out from under a rotation check and `UnauthorizedAccessException` for one
    // this process may not read, and both are routine.
    'if ($null -ne $WtmBlock) { try {'
      + ' $WtmOut = [string]::Join([string][char]10, @(& $WtmBlock'
      + " | Microsoft.PowerShell.Core\\ForEach-Object { [string]$_ })); $WtmOk = '1' }"
      + " catch { $WtmOk = '0'; $WtmOut = '' } }",
    `[Console]::Out.WriteLine('${token} ' + $WtmOk + ' ' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$WtmOut)))`,
  ].join('; ');
}

interface Pending {
  readonly script: string;
  readonly resolve: (value: string) => void;
  readonly reject: (error: Error) => void;
  token: string;
  queueTimer: ReturnType<typeof setTimeout> | undefined;
  runTimer: ReturnType<typeof setTimeout> | undefined;
}

function detach(target: { unref?(): unknown } | undefined): void {
  try { target?.unref?.(); } catch { /* A fake, or a stream that cannot be detached; harmless. */ }
}

export function createPowershellSession(options: PowershellSessionOptions = {}): PowershellSession {
  const settings = { ...defaults, ...options };
  const start = options.spawn ?? ((file, args, spawnOptions) =>
    nodeSpawn(file, [...args], spawnOptions) as unknown as PowershellChild);
  const now = options.now ?? Date.now;

  const queue: Pending[] = [];
  let active: Pending | undefined;
  let child: PowershellChild | undefined;
  let buffer = '';
  let bytes = 0;
  let served = 0;
  let bornAt = 0;
  let consecutiveFailures = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  function clearIdle(): void {
    if (idleTimer !== undefined) { clearTimeout(idleTimer); idleTimer = undefined; }
  }

  /** Kills the process and fails whatever it was running. Queued work survives for a new one. */
  function retire(reason: string): void {
    const running = active;
    active = undefined;
    const victim = child;
    child = undefined;
    buffer = '';
    bytes = 0;
    clearIdle();
    if (victim !== undefined) { try { victim.kill('SIGKILL'); } catch { /* Already gone. */ } }
    if (running !== undefined) {
      if (running.queueTimer !== undefined) clearTimeout(running.queueTimer);
      if (running.runTimer !== undefined) clearTimeout(running.runTimer);
      running.reject(new Error(reason));
    }
  }

  /**
   * `'1'` the script ran, `'0'` the script threw, `'2'` the wrapper itself threw before the
   * script ever ran. Only `'2'` (and an undecodable payload) says anything about the interpreter.
   */
  function settle(token: string, status: string, payload: string): void {
    const running = active;
    // A frame whose token is not the running request's is late output from a request that was
    // already failed. It can never satisfy a different one: tokens are fresh random per request.
    if (running === undefined || running.token !== token) return;
    active = undefined;
    buffer = '';
    bytes = 0;
    if (running.runTimer !== undefined) clearTimeout(running.runTimer);
    served += 1;
    let decoded: string | undefined;
    if (status === '1') {
      try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(payload, 'base64')); }
      catch { decoded = undefined; }
    }
    if (decoded !== undefined) {
      consecutiveFailures = 0;
      running.resolve(decoded);
      pump();
      return;
    }
    running.reject(new Error(status === '0' ? 'POWERSHELL_SESSION_COMMAND_FAILED'
      : status === '2' ? 'POWERSHELL_SESSION_WRAPPER_FAILED' : 'POWERSHELL_SESSION_ENCODING'));
    // Only a failure the *wrapper* owns is evidence about the interpreter. A script failure is
    // not: `Get-Acl` throws for a path that no longer exists or whose ACL this process may not
    // read, both of which `windows-acl-batch.ts` already treats as routine enough to isolate per
    // path -- and a rotation renaming a log file out from under a check is exactly what
    // `logs.test.ts` constructs. Counting those would SIGKILL a healthy interpreter every third
    // refusal and pay a cold start to replace it, which is the cost this whole unit exists to
    // remove. An undecodable payload does count: the frame builds it with
    // `ToBase64String(UTF8.GetBytes(...))`, so a well-behaved interpreter cannot produce one and
    // no script-level condition can cause it either.
    if (status !== '0') {
      consecutiveFailures += 1;
      if (consecutiveFailures >= settings.maxConsecutiveFailures) retire('POWERSHELL_SESSION_WEDGED');
    }
    pump();
  }

  function consume(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > settings.maxResponseBytes) { retire('POWERSHELL_SESSION_OUTPUT_LIMIT'); pump(); return; }
    buffer += text;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      // The payload group is optional because an empty base64 body leaves a trailing space that
      // a console or a trim can eat; a framed failure with no output is still a framed failure.
      const match = /^([0-9a-f]{32}) ([0-2])(?: ([A-Za-z0-9+/=]*))?$/.exec(line);
      // Anything that is not a response frame is a diagnostic the script wrote to the console.
      // It is discarded rather than parsed: only a framed line can settle a request.
      if (match !== null) { settle(match[1]!, match[2]!, match[3] ?? ''); return; }
      newline = buffer.indexOf('\n');
    }
  }

  function ensureChild(): PowershellChild {
    if (child !== undefined) return child;
    const started = start('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child = started;
    bornAt = now();
    served = 0;
    consecutiveFailures = 0;
    buffer = '';
    bytes = 0;
    started.stdout.on('data', (data) => { if (child === started) consume(data); });
    // stderr counts against the same bound but never reaches a caller: PowerShell diagnostics
    // carry the path being inspected, and a refusal must not become a path disclosure channel.
    started.stderr.on('data', (data: Buffer | string) => {
      if (child !== started) return;
      bytes += Buffer.byteLength(typeof data === 'string' ? data : data.toString('utf8'), 'utf8');
      if (bytes > settings.maxResponseBytes) { retire('POWERSHELL_SESSION_OUTPUT_LIMIT'); pump(); }
    });
    started.on('error', () => { if (child === started) { retire('POWERSHELL_SESSION_FAILED'); pump(); } });
    started.stdin.on('error', () => { if (child === started) { retire('POWERSHELL_SESSION_FAILED'); pump(); } });
    started.once('close', () => { if (child === started) { retire('POWERSHELL_SESSION_CLOSED'); pump(); } });
    for (const line of prologue) started.stdin.write(`${line}\n`);
    return started;
  }

  function expired(): boolean {
    return child !== undefined
      && (served >= settings.maxRequests || now() - bornAt >= settings.maxLifetimeMs);
  }

  function pump(): void {
    if (closed || active !== undefined) return;
    const next = queue.shift();
    if (next === undefined) {
      if (child !== undefined && idleTimer === undefined) {
        // Nothing is waiting on this process, so it must not keep the event loop alive.
        detach(child); detach(child.stdout); detach(child.stderr); detach(child.stdin);
        idleTimer = setTimeout(() => { idleTimer = undefined; retire('POWERSHELL_SESSION_IDLE'); },
          settings.idleTimeoutMs);
        detach(idleTimer as unknown as { unref?(): unknown });
      }
      return;
    }
    clearIdle();
    // A budget is spent between requests, never during one: an in-flight request is never
    // interrupted by the session's own lifetime bound.
    if (expired()) retire('POWERSHELL_SESSION_RECYCLED');
    if (next.queueTimer !== undefined) { clearTimeout(next.queueTimer); next.queueTimer = undefined; }
    active = next;
    next.token = randomBytes(16).toString('hex');
    next.runTimer = setTimeout(() => { retire('POWERSHELL_SESSION_TIMEOUT'); pump(); },
      settings.requestTimeoutMs);
    let started: PowershellChild;
    try { started = ensureChild(); }
    catch { retire('POWERSHELL_SESSION_FAILED'); pump(); return; }
    try { started.stdin.write(`${frame(next.script, next.token)}\n`); }
    catch { retire('POWERSHELL_SESSION_FAILED'); pump(); }
  }

  return {
    run(script) {
      return new Promise<string>((resolve, reject) => {
        if (closed) { reject(new Error('POWERSHELL_SESSION_CLOSED')); return; }
        // Windows PowerShell 5.1's `-Command -` ends its input on a *blank line*, not only on
        // EOF. No script this package composes is empty, but nothing else enforces that, and an
        // empty one would frame down to a blank statement and silently shut the interpreter. A
        // structural refusal is cheaper than a session that dies for a reason nothing reports.
        if (script.trim() === '') { reject(new Error('POWERSHELL_SESSION_EMPTY_SCRIPT')); return; }
        if (queue.length >= settings.maxQueued) { reject(new Error('POWERSHELL_SESSION_QUEUE_LIMIT')); return; }
        const pending: Pending = { script, resolve, reject, token: '', queueTimer: undefined, runTimer: undefined };
        pending.queueTimer = setTimeout(() => {
          const index = queue.indexOf(pending);
          if (index < 0) return;
          queue.splice(index, 1);
          pending.queueTimer = undefined;
          pending.reject(new Error('POWERSHELL_SESSION_QUEUE_TIMEOUT'));
        }, settings.queueTimeoutMs);
        detach(pending.queueTimer as unknown as { unref?(): unknown });
        queue.push(pending);
        pump();
      });
    },
    close() {
      closed = true;
      retire('POWERSHELL_SESSION_CLOSED');
      while (queue.length > 0) {
        const pending = queue.shift()!;
        if (pending.queueTimer !== undefined) clearTimeout(pending.queueTimer);
        pending.reject(new Error('POWERSHELL_SESSION_CLOSED'));
      }
    },
  };
}

/**
 * Adapts a session to the `PowershellRunner` seam `windows-powershell.ts` already exposes, so the
 * ACL reader and the current-user-SID reader are unchanged and their fixture tests keep passing:
 * only where the process comes from changed.
 */
export function createPooledPowershellRunner(
  options: PowershellSessionOptions = {},
): PowershellRunner & { close(): void } {
  const session = createPowershellSession(options);
  const runner = async (args: readonly string[]): Promise<{ stdout: string }> => {
    // Argv-shaped because `PowershellRunner` already is: keeping that seam byte-identical is what
    // lets every `windows-powershell.test.ts` fixture keep passing unchanged, so this change is
    // provably only about where the process comes from. The session supplies `-NoProfile` and
    // `-NonInteractive` itself, so the script after `-Command` is the whole of the request.
    const index = args.indexOf('-Command');
    const script = index < 0 ? undefined : args[index + 1];
    if (script === undefined) throw new Error('POWERSHELL_SESSION_SCRIPT_MISSING');
    return { stdout: await session.run(script) };
  };
  return Object.assign(runner, { close: () => { session.close(); } });
}
