import { createRequire } from 'node:module';

export async function runProcessAnchor(marker: string): Promise<number> {
  if (!/^[a-f0-9]{64}$/.test(marker)) return 2;
  const completed = new Promise<number>((resolve) => {
    process.once('beforeExit', () => resolve(
      typeof process.exitCode === 'number' ? process.exitCode : 1,
    ));
  });
  const run = Function('require', anchorSource) as (require: NodeJS.Require) => void;
  run(createRequire(import.meta.url));
  return await completed;
}

/** The identity the anchor reports in its `READY` handshake, in the dialect it was told to speak. */
export interface AnchorObservedIdentity {
  pid: number;
  pgid: number;
  processStartTime: string;
  commandFingerprint: string;
}

/**
 * Node-style callbacks rather than promises because the fragment they come from is compiled into a
 * child that has no bundler, no `await` at its top level and nothing to catch a rejection.
 */
export interface AnchorReaders {
  /** Reads *this* process. The anchor has no other process to ask about, and neither has a test. */
  readIdentity(callback: (error: unknown, identity: AnchorObservedIdentity | null) => void): void;
  readGroupMembers(pgid: number, callback: (error: unknown, pids: readonly number[] | null) => void): void;
}

export interface AnchorReaderSpec {
  /** The platform id the supervisor selected, never one the anchor observed — see D1. */
  platform: string;
  /**
   * Only the compiled-in-a-test path sets this. The anchor passes the platform and nothing else, so
   * `WTM_ANCHOR_SPEC` cannot redirect a running anchor's `/proc`; a test points the same text at a
   * captured one, which is the only way the Linux reader can be exercised from a macOS machine.
   */
  procRoot?: string;
  /**
   * Only the compiled-in-a-test path sets this. There is no captured-directory equivalent for a
   * single PowerShell command's JSON output the way `procRoot` gives the Linux reader one, so a
   * test substitutes the command itself. `compileAnchorReaders` hands `spec` to the compiled
   * function directly rather than through `JSON.stringify`/`JSON.parse` (unlike the real anchor's
   * `WTM_ANCHOR_SPEC` environment variable, which only ever carries `platform`), so a function
   * value survives here in a way it could not on the production path.
   */
  windowsQueryRunner?: (
    script: string,
    callback: (error: unknown, stdout: string | null, selfPid?: number) => void,
  ) => void;
}

/**
 * Compiles the anchor's readers out of the same source text the spawned child runs, so a test can
 * hold them against `@wtm/platform` and fail when the two drift. This is the mitigation D2 owes for
 * inlining the readers at all; without it the duplication would be a silent time bomb.
 */
export function compileAnchorReaders(spec: AnchorReaderSpec): AnchorReaders {
  const compile = Function('require', 'spec', `${anchorReaderSource}\nreturn createAnchorReaders(spec);`) as (
    require: NodeJS.Require, spec: AnchorReaderSpec,
  ) => AnchorReaders;
  return compile(createRequire(import.meta.url), spec);
}

/**
 * The anchor's process readers, one per platform, duplicating
 * `packages/platform/src/process/{darwin,linux,proc-stat,identity}.ts`.
 *
 * The duplication is forced rather than chosen: the anchor is a source string compiled with
 * `Function('require', ...)` inside the spawned child, so it has no module graph and no way to
 * import `@wtm/platform` at all. What keeps the copy honest is that it lives in one
 * fragment with one entry point, that `compileAnchorReaders` compiles that same text, and that
 * `__tests__/process-anchor.test.ts` runs both implementations over one live process and one
 * captured `/proc` and requires byte-identical output. Drift is a red build.
 *
 * `spec.platform` is what the supervisor selected. Nothing here reads `process.platform`: the
 * dialect this reports in is a property of the decision already made on the other side of the pipe,
 * and a second, independent observation could only ever disagree with it — surfacing as
 * `ANCHOR_IDENTITY_MISMATCH`, which accuses the process of changing identity when the two sides
 * were merely spelling one identity two ways.
 */
const anchorReaderSource = String.raw`
function createAnchorReaders(spec) {
  const childProcess = require('node:child_process');
  const crypto = require('node:crypto');
  const nodeFs = require('node:fs');
  const procRoot = typeof spec.procRoot === 'string' ? spec.procRoot : '/proc';

  // observedCommandFingerprint, from platform/src/process/identity.ts. The trailing-marker collapse
  // is why the fingerprint survives the anchor's own transition: its command line stops being
  // 'wtm __wtm_internal_anchor <marker>' the moment it starts supervising the real task, and the
  // supervisor still has to recognise the process it started.
  function commandFingerprint(executable, command) {
    const marker = /(?:^|\s)([a-f0-9]{64})\s*$/.exec(command);
    return crypto.createHash('sha256')
      .update(executable)
      .update('\0')
      .update(marker === null ? command : 'wtm-anchor:' + marker[1])
      .digest('hex');
  }

  function stableEnvironment() { return { ...process.env, LC_ALL: 'C', LANG: 'C' }; }

  const darwin = {
    readIdentity(callback) {
      childProcess.execFile('ps', [
        '-ww', '-p', String(process.pid), '-o', 'pgid=', '-o', 'state=', '-o', 'lstart=', '-o', 'comm=', '-o', 'command='
      ], {
        encoding: 'utf8', env: stableEnvironment(), maxBuffer: 64 * 1024, timeout: 1000
      }, (error, stdout) => {
        if (error) return callback(error, null);
        const line = stdout.split(/\r?\n/).find((value) => value.trim().length > 0) || '';
        const match = /^\s*(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
        if (match === null) return callback(new Error('PS_PARSE_FAILED'), null);
        callback(null, {
          pid: process.pid,
          pgid: Number(match[1]),
          processStartTime: match[3],
          commandFingerprint: commandFingerprint(match[4], match[5])
        });
      });
    },
    readGroupMembers(pgid, callback) {
      const inspector = childProcess.execFile('ps', ['-axo', 'pid=', '-o', 'pgid=', '-o', 'state='], {
        encoding: 'utf8', env: stableEnvironment(), maxBuffer: 4 * 1024 * 1024, timeout: 1000
      }, (error, stdout) => {
        if (error) return callback(error, null);
        // The 'ps' doing the reporting was forked from this process and is therefore in the group it
        // is reporting on. It is removed here rather than by the caller so that both platforms'
        // readers answer one question — who else is still alive — instead of two.
        callback(null, stdout.split(/\r?\n/).flatMap((line) => {
          const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
          if (match === null || Number(match[2]) !== pgid || match[3].startsWith('Z')) return [];
          return Number(match[1]) === inspector.pid ? [] : [Number(match[1])];
        }));
      });
    }
  };

  // parseProcStat, from platform/src/process/proc-stat.ts. 'comm' ends at the LAST ')' in the line:
  // a process named 'weird) app)' is legal, the kernel escapes nothing, and splitting on whitespace
  // reads a fault count as a process group and a page count as a start time.
  function fieldIndex(n) { return n - 3; }
  function parseDigits(value) {
    if (!/^\d+$/.test(value)) return null;
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  function parseProcStat(content) {
    const line = content.replace(/\n$/, '');
    const opening = line.indexOf('(');
    const closing = line.lastIndexOf(')');
    if (opening < 0 || closing < opening) return null;
    const pid = parseDigits(line.slice(0, opening).trim());
    if (pid === null || pid < 1) return null;
    const rest = line.slice(closing + 1).trim().split(/\s+/).filter((field) => field.length > 0);
    if (rest.length <= fieldIndex(22)) return null;
    const state = rest[fieldIndex(3)];
    if (state.length !== 1) return null;
    const pgrp = parseDigits(rest[fieldIndex(5)]);
    if (pgrp === null) return null;
    const startTimeTicks = rest[fieldIndex(22)];
    if (!/^\d+$/.test(startTimeTicks)) return null;
    return { pid: pid, state: state, pgrp: pgrp, startTimeTicks: startTimeTicks };
  }
  function parseBootTime(content) {
    for (const line of content.split('\n')) {
      if (!line.startsWith('btime ')) continue;
      const value = line.slice('btime '.length).trim();
      return /^\d+$/.test(value) ? value : null;
    }
    return null;
  }
  // Absent or unreadable are the same answer to the only question being asked: every real member of
  // this group was forked by this anchor, so it is same-uid and readable. An entry that is neither
  // belongs to somebody else, and failing the whole scan over it — under hidepid, in a container, on
  // a shared host — would leave the drain poll retrying forever and the anchor would never exit.
  function unreadableEntry(error) {
    return error.code === 'ENOENT' || error.code === 'ESRCH'
      || error.code === 'EACCES' || error.code === 'EPERM';
  }

  const linux = {
    readIdentity(callback) {
      const directory = procRoot + '/' + String(process.pid);
      let statContent;
      let commContent;
      let commandLineContent;
      let bootContent;
      try {
        statContent = nodeFs.readFileSync(directory + '/stat', 'utf8');
        // 'comm' is the kernel's 15-byte task name and 'cmdline' is NUL-separated with a trailing
        // NUL. They are the two halves the port hashes, spelled the way the port spells them, which
        // is what makes the fingerprints comparable at all.
        commContent = nodeFs.readFileSync(directory + '/comm', 'utf8');
        commandLineContent = nodeFs.readFileSync(directory + '/cmdline', 'utf8');
        bootContent = nodeFs.readFileSync(procRoot + '/stat', 'utf8');
      } catch (error) { return callback(error, null); }
      const fields = parseProcStat(statContent);
      const bootTime = parseBootTime(bootContent);
      if (fields === null || bootTime === null) return callback(new Error('PROC_PARSE_FAILED'), null);
      // The kernel names the directory after the PID, so a line reporting a different one means the
      // file read is not the file asked for.
      if (fields.pid !== process.pid || fields.pgrp < 1) return callback(new Error('PROC_PARSE_FAILED'), null);
      callback(null, {
        pid: process.pid,
        pgid: fields.pgrp,
        processStartTime: bootTime + ':' + fields.startTimeTicks,
        commandFingerprint: commandFingerprint(
          commContent.replace(/\n$/, ''),
          commandLineContent.replace(/\0+$/, '').split('\0').join(' ')
        )
      });
    },
    readGroupMembers(pgid, callback) {
      let entries;
      try { entries = nodeFs.readdirSync(procRoot); }
      catch (error) { return callback(error, null); }
      const members = [];
      for (const entry of entries) {
        // '/proc' mixes PID directories with cpuinfo, self and the rest. Only all-digit names are
        // processes.
        if (!/^\d+$/.test(entry)) continue;
        let content;
        try { content = nodeFs.readFileSync(procRoot + '/' + entry + '/stat', 'utf8'); }
        catch (error) {
          if (unreadableEntry(error)) continue;
          return callback(error, null);
        }
        const fields = parseProcStat(content);
        if (fields === null) return callback(new Error('PROC_PARSE_FAILED'), null);
        if (fields.pgrp === pgid && !fields.state.startsWith('Z')) members.push(fields.pid);
      }
      callback(null, members);
    }
  };

  // windowsProcessFieldsSelect/windowsOneProcessScript/windowsAllProcessesScript/
  // parseWindowsProcessList, from platform/src/process/windows.ts. CreationDate is asked for in
  // round-trip ('o') format for the same reason the port asks for it that way: PowerShell's default
  // ConvertTo-Json serialization of a DateTime is the ambiguous '/Date(...)/ ' shape, not a string
  // this code would want to parse.
  function windowsProcessFieldsSelect() {
    return "@{n='ProcessId';e={$_.ProcessId}}, @{n='ParentProcessId';e={$_.ParentProcessId}}, "
      + "@{n='CreationDate';e={ if ($_.CreationDate) { $_.CreationDate.ToString('o') } else { '' } }}, "
      + "@{n='Name';e={$_.Name}}, @{n='CommandLine';e={$_.CommandLine}}";
  }
  function windowsOneProcessScript(pid) {
    return "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process -Filter 'ProcessId=" + pid + "' | "
      + 'Select-Object ' + windowsProcessFieldsSelect() + ' | ConvertTo-Json -Compress';
  }
  function windowsAllProcessesScript() {
    return "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | "
      + 'Select-Object ' + windowsProcessFieldsSelect() + ' | ConvertTo-Json -Compress';
  }
  function parseWindowsProcessList(stdout) {
    const trimmed = stdout.trim();
    if (trimmed.length === 0) return [];
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch (error) { return null; }
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    const records = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.ProcessId !== 'number' || typeof entry.ParentProcessId !== 'number') continue;
      if (typeof entry.CreationDate !== 'string' || typeof entry.Name !== 'string') continue;
      records.push({
        ProcessId: entry.ProcessId,
        ParentProcessId: entry.ParentProcessId,
        CreationDate: entry.CreationDate,
        Name: entry.Name,
        CommandLine: typeof entry.CommandLine === 'string' ? entry.CommandLine : ''
      });
    }
    return records;
  }

  /**
   * Only the compiled-in-a-test path sets spec.windowsQueryRunner (see AnchorReaderSpec's own doc
   * comment); a real anchor spawns powershell.exe for real and reports its own pid back as the
   * third callback argument. readGroupMembers needs that pid — see its own comment below — and
   * readIdentity ignores it, since asking about its own pid is the point there, not something to
   * exclude.
   */
  function runWindowsQuery(script, callback) {
    if (typeof spec.windowsQueryRunner === 'function') return spec.windowsQueryRunner(script, callback);
    const child = childProcess.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024
    }, function (error, stdout) {
      callback(error, error ? null : stdout, child.pid);
    });
  }

  // walkWindowsTree, from platform/src/process/windows.ts's inspectProcessGroup: walked from the
  // direct children of pgid rather than from pgid's own record, and not gated on that record
  // existing, because the root can have already exited while its children linger as orphans (D2:
  // Windows never clears a dead parent's declared ParentProcessId). selfPid drops the transient
  // powershell.exe this very query spawned — when the anchor asks about its own tree, that process
  // is briefly a real child of the anchor and the snapshot necessarily catches it mid-execution, the
  // same reason the darwin reader above excludes its own ps child.
  function walkWindowsTree(records, pgid, selfPid) {
    const byPid = {};
    for (const record of records) byPid[record.ProcessId] = record;
    const childrenByParent = {};
    for (const record of records) {
      if (record.ProcessId === record.ParentProcessId || record.ProcessId === selfPid) continue;
      const list = childrenByParent[record.ParentProcessId] || (childrenByParent[record.ParentProcessId] = []);
      list.push(record);
    }
    const root = byPid[pgid];
    const pids = root ? [pgid] : [];
    const queue = [];
    const rootCreationDate = root ? root.CreationDate : '';
    for (const child of (childrenByParent[pgid] || [])) {
      if (child.CreationDate !== '' && rootCreationDate !== '' && child.CreationDate < rootCreationDate) continue;
      pids.push(child.ProcessId);
      queue.push(child);
    }
    while (queue.length > 0) {
      const parent = queue.shift();
      const children = childrenByParent[parent.ProcessId] || [];
      for (const child of children) {
        if (child.CreationDate !== '' && parent.CreationDate !== '' && child.CreationDate < parent.CreationDate) continue;
        pids.push(child.ProcessId);
        queue.push(child);
      }
    }
    return pids;
  }

  const windows = {
    readIdentity(callback) {
      runWindowsQuery(windowsOneProcessScript(process.pid), function (error, stdout) {
        if (error) return callback(error, null);
        const records = parseWindowsProcessList(stdout);
        if (records === null) return callback(new Error('POWERSHELL_PARSE_FAILED'), null);
        const match = records.find(function (record) { return record.ProcessId === process.pid; });
        if (!match) return callback(new Error('ANCHOR_SELF_NOT_FOUND'), null);
        callback(null, {
          pid: process.pid,
          pgid: process.pid,
          processStartTime: match.CreationDate,
          commandFingerprint: commandFingerprint(match.Name, match.CommandLine)
        });
      });
    },
    readGroupMembers(pgid, callback) {
      runWindowsQuery(windowsAllProcessesScript(), function (error, stdout, selfPid) {
        if (error) return callback(error, null);
        const records = parseWindowsProcessList(stdout);
        if (records === null) return callback(new Error('POWERSHELL_PARSE_FAILED'), null);
        callback(null, walkWindowsTree(records, pgid, selfPid));
      });
    }
  };

  if (spec.platform === 'darwin') return darwin;
  if (spec.platform === 'linux') return linux;
  if (spec.platform === 'win32') return windows;
  // The supervisor always names one. A missing or unknown value is not a reason to fall back on
  // asking the machine — asking is exactly what D1 forbids — so the anchor fails to identify
  // itself, which the supervisor already reads as ANCHOR_HANDSHAKE_INVALID and rolls back.
  return {
    readIdentity(callback) { callback(new Error('ANCHOR_PLATFORM_UNKNOWN'), null); },
    readGroupMembers(pgid, callback) { callback(new Error('ANCHOR_PLATFORM_UNKNOWN'), null); }
  };
}
`;

export const anchorSource = String.raw`
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const { closeSync } = fs;
const { Writable, pipeline } = require('node:stream');
const pathModule = require('node:path');
const spec = JSON.parse(process.env.WTM_ANCHOR_SPEC || '{}');
delete process.env.WTM_ANCHOR_SPEC;
// The platform, and only the platform: a 'procRoot' arriving through the environment would let the
// spec redirect a running anchor's '/proc', which nothing in the product needs.
const readers = createAnchorReaders({ platform: spec.platform });
let taskExit = { code: 1, signal: null };
let taskExited = false;
const anchorReadyAt = Date.now() + 250;
process.on('SIGTERM', () => {});
const signalNumbers = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
let stdoutDrained = false;
let stderrDrained = false;
let logFailed = false;
let finished = false;
function assertSecureDirectoryChain(root, directory) {
  const resolvedRoot = pathModule.resolve(root);
  const resolvedDirectory = pathModule.resolve(directory);
  const relative = pathModule.relative(resolvedRoot, resolvedDirectory);
  if (relative === '..' || relative.startsWith('..' + pathModule.sep) || pathModule.isAbsolute(relative)) {
    throw new Error('LOG_PATH_OUTSIDE_ROOT');
  }
  let current = resolvedRoot;
  for (const part of relative === '' ? [] : relative.split(pathModule.sep)) {
    checkDirectory(current);
    current = pathModule.join(current, part);
  }
  checkDirectory(current);
}
function checkDirectory(path) {
  const stat = fs.lstatSync(path);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || (uid !== undefined && stat.uid !== uid)) {
    throw new Error('UNSAFE_LOG_DIRECTORY');
  }
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid };
}
function assertDirectoryIdentity(path, expected) {
  const current = checkDirectory(path);
  if (current.dev !== expected.dev || current.ino !== expected.ino || current.uid !== expected.uid) {
    throw new Error('LOG_DIRECTORY_CHANGED');
  }
}
function checkFile(path) {
  try {
    const stat = fs.lstatSync(path);
    const uid = process.getuid?.();
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (uid !== undefined && stat.uid !== uid)) {
      throw new Error('UNSAFE_LOG_TARGET');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
function secureOpen(path) {
  checkFile(path);
  const fd = fs.openSync(path, fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  const stat = fs.fstatSync(fd);
  const uid = process.getuid?.();
  if (!stat.isFile() || stat.nlink !== 1 || (uid !== undefined && stat.uid !== uid)) {
    closeSync(fd); throw new Error('UNSAFE_LOG_TARGET');
  }
  fs.fchmodSync(fd, 0o600);
  return { fd, size: stat.size };
}
function readGeneration(path, currentPath) {
  try {
    checkFile(path);
    const value = fs.readFileSync(path, 'utf8').trim();
    if (/^\d+$/.test(value)) return Number(value);
    const phased = /^rotating-(\d+)-(marker|closed|shifted|archived|opened)-[A-Za-z0-9-]+$/.exec(value);
    if (phased) {
      const archived = phased[2] === 'archived' || phased[2] === 'opened' || !fs.existsSync(currentPath);
      return Number(phased[1]) + (archived ? 1 : 0);
    }
    if (/^rotating-[A-Za-z0-9-]+$/.test(value)) {
      const current = (() => { try { return fs.lstatSync(currentPath); } catch { return null; } })();
      return current === null || current.size === 0 && fs.existsSync(currentPath + '.1') ? 1 : 0;
    }
    throw new Error('INVALID_LOG_GENERATION_MARKER');
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}
function readGenerationMarker(path) {
  try {
    checkFile(path);
    return fs.readFileSync(path, 'utf8').trim();
  } catch (error) {
    if (error.code === 'ENOENT') return '0';
    throw error;
  }
}
function hasSafeFile(path) {
  checkFile(path);
  try { fs.lstatSync(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function safeFileSize(path) {
  checkFile(path);
  try { return fs.lstatSync(path).size; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function publishGeneration(path, value) {
  checkFile(path);
  const temporary = path + '.tmp-' + process.pid + '-' + Math.random().toString(16).slice(2);
  fs.writeFileSync(temporary, String(value), { flag: 'wx', mode: 0o600 });
  try { fs.renameSync(temporary, path); }
  catch (error) { try { fs.rmSync(temporary); } catch {} throw error; }
}
function publishLaunch(path, root) {
  const directory = pathModule.dirname(path);
  assertSecureDirectoryChain(root, directory);
  const parent = checkDirectory(directory);
  checkFile(path);
  const temporary = path + '.tmp-' + process.pid + '-' + Math.random().toString(16).slice(2);
  fs.writeFileSync(temporary, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
  try {
    assertDirectoryIdentity(directory, parent);
    fs.renameSync(temporary, path);
    assertDirectoryIdentity(directory, parent);
  }
  catch (error) { try { fs.rmSync(temporary); } catch {} throw error; }
}
class RotatingLog extends Writable {
  constructor(path, root, limit, retained) {
    super({ highWaterMark: 16 * 1024 });
    this.path = path;
    this.root = root;
    this.limit = limit;
    this.retained = retained;
    this.markerPath = path + '.generation';
    this.directory = pathModule.dirname(path);
    assertSecureDirectoryChain(root, this.directory);
    this.parentIdentity = checkDirectory(this.directory);
    this.generation = this.recoverGeneration(readGenerationMarker(this.markerPath));
    this.verifyParent();
    const opened = secureOpen(path);
    this.verifyParent();
    this.fd = opened.fd;
    this.size = opened.size;
    const recoveryMarker = readGenerationMarker(this.markerPath);
    const recovery = /^rotating-(\d+)-(marker|closed|shifted|archived|opened)-([A-Za-z0-9-]+)$/.exec(recoveryMarker);
    if (recovery) {
      publishGeneration(this.markerPath, 'rotating-' + recovery[1] + '-opened-' + recovery[3]);
      this.verifyParent();
    }
    publishGeneration(this.markerPath, this.generation);
    this.verifyParent();
  }
  recoverGeneration(marker) {
    const phased = /^rotating-(\d+)-(marker|closed|shifted|archived|opened)-([A-Za-z0-9-]+)$/.exec(marker);
    if (!phased) return readGeneration(this.markerPath, this.path);
    const generation = Number(phased[1]);
    const phase = phased[2];
    const transaction = phased[3];
    this.verifyParent();
    if (phase === 'archived' || phase === 'opened') {
      if (!hasSafeFile(this.path + '.1') || phase === 'opened' && !hasSafeFile(this.path)) {
        throw new Error('AMBIGUOUS_LOG_ROTATION_RECOVERY');
      }
      return generation + 1;
    }
    if (!hasSafeFile(this.path)) {
      if (phase !== 'shifted' || !hasSafeFile(this.path + '.1')) {
        throw new Error('AMBIGUOUS_LOG_ROTATION_RECOVERY');
      }
      publishGeneration(this.markerPath, 'rotating-' + generation + '-archived-' + transaction);
      this.verifyParent();
      return generation + 1;
    }
    if ((phase === 'marker' || phase === 'closed') && safeFileSize(this.path) === 0) {
      throw new Error('AMBIGUOUS_LOG_ROTATION_RECOVERY');
    }
    if (phase === 'shifted' && !hasSafeFile(this.path + '.1') && safeFileSize(this.path) === 0) {
      throw new Error('AMBIGUOUS_LOG_ROTATION_RECOVERY');
    }
    if (phase === 'shifted' && hasSafeFile(this.path + '.1') && safeFileSize(this.path) === 0) {
      publishGeneration(this.markerPath, 'rotating-' + generation + '-archived-' + transaction);
      this.verifyParent();
      return generation + 1;
    }
    if (phase !== 'shifted') {
      const present = Array.from({ length: this.retained }, (_, index) => hasSafeFile(this.path + '.' + (index + 1)));
      const firstMissing = present.findIndex((value) => !value);
      let shiftStart;
      if (firstMissing < 0) {
        this.verifyParent();
        fs.rmSync(this.path + '.' + this.retained);
        this.verifyParent();
        shiftStart = this.retained - 1;
      } else {
        shiftStart = firstMissing;
      }
      for (let suffix = shiftStart; suffix >= 1; suffix -= 1) {
        const source = this.path + '.' + suffix;
        const target = this.path + '.' + (suffix + 1);
        if (!hasSafeFile(source)) continue;
        if (hasSafeFile(target)) throw new Error('AMBIGUOUS_LOG_ROTATION_RECOVERY');
        this.verifyParent();
        fs.renameSync(source, target);
        this.verifyParent();
      }
      publishGeneration(this.markerPath, 'rotating-' + generation + '-shifted-' + transaction);
    }
    if (hasSafeFile(this.path + '.1')) throw new Error('AMBIGUOUS_LOG_ROTATION_RECOVERY');
    this.verifyParent();
    fs.renameSync(this.path, this.path + '.1');
    this.verifyParent();
    publishGeneration(this.markerPath, 'rotating-' + generation + '-archived-' + transaction);
    return generation + 1;
  }
  _write(chunk, _encoding, callback) {
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (this.size >= this.limit) this.rotate();
        const length = Math.min(chunk.length - offset, this.limit - this.size);
        let written = 0;
        while (written < length) {
          written += fs.writeSync(this.fd, chunk, offset + written, length - written);
        }
        offset += length;
        this.size += length;
      }
      callback();
    } catch (error) { logFailed = true; callback(error); }
  }
  _final(callback) {
    try { closeSync(this.fd); callback(); }
    catch (error) { logFailed = true; callback(error); }
  }
  _destroy(error, callback) {
    try { closeSync(this.fd); } catch {}
    callback(error);
  }
  rotate() {
    this.verifyParent();
    const transaction = process.pid + '-' + Date.now();
    publishGeneration(this.markerPath, 'rotating-' + this.generation + '-marker-' + transaction);
    this.verifyParent();
    closeSync(this.fd);
    publishGeneration(this.markerPath, 'rotating-' + this.generation + '-closed-' + transaction);
    const oldest = this.path + '.' + this.retained;
    checkFile(oldest);
    try { fs.rmSync(oldest); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.verifyParent();
    for (let generation = this.retained - 1; generation >= 1; generation -= 1) {
      const source = this.path + '.' + generation;
      checkFile(source);
      try { fs.renameSync(source, this.path + '.' + (generation + 1)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      this.verifyParent();
    }
    publishGeneration(this.markerPath, 'rotating-' + this.generation + '-shifted-' + transaction);
    checkFile(this.path);
    fs.renameSync(this.path, this.path + '.1');
    this.verifyParent();
    publishGeneration(this.markerPath, 'rotating-' + this.generation + '-archived-' + transaction);
    const opened = secureOpen(this.path);
    this.verifyParent();
    publishGeneration(this.markerPath, 'rotating-' + this.generation + '-opened-' + transaction);
    this.fd = opened.fd;
    this.size = 0;
    this.generation += 1;
    publishGeneration(this.markerPath, this.generation);
    this.verifyParent();
  }
  verifyParent() {
    assertSecureDirectoryChain(this.root, this.directory);
    assertDirectoryIdentity(this.directory, this.parentIdentity);
  }
}
function launch() {
  let stdoutLog;
  let stderrLog;
  try {
    stdoutLog = new RotatingLog(spec.logs.stdoutPath, spec.logs.root, spec.logs.rotationBytes, spec.logs.retainedFiles);
    stderrLog = new RotatingLog(spec.logs.stderrPath, spec.logs.root, spec.logs.rotationBytes, spec.logs.retainedFiles);
  } catch {
    logFailed = true; stdoutDrained = true; stderrDrained = true; taskExited = true;
    reportLaunch('ERROR LOG_SETUP_FAILED'); checkGroup(); return;
  }
  const child = spawn(spec.argv[0], spec.argv.slice(1), {
    cwd: process.cwd(), env: process.env, shell: spec.shell === true, stdio: ['ignore', 'pipe', 'pipe']
  });
  child.once('spawn', () => {
    try { publishLaunch(spec.logs.launchMarkerPath, spec.logs.root); reportLaunch('LAUNCHED'); }
    catch { logFailed = true; reportLaunch('ERROR LAUNCH_MARKER_FAILED'); }
  });
  child.once('error', (error) => {
    reportLaunch('ERROR ' + (/^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'SPAWN_FAILED'));
    taskExited = true; taskExit = { code: 127, signal: null }; checkGroup();
  });
  child.once('exit', (code, signal) => { taskExited = true; taskExit = { code, signal }; checkGroup(); });
  if (child.stdout) pipeline(child.stdout, stdoutLog, (error) => { logFailed ||= error !== undefined && error !== null; stdoutDrained = true; checkGroup(); });
  else { stdoutLog.end(() => { stdoutDrained = true; checkGroup(); }); }
  if (child.stderr) pipeline(child.stderr, stderrLog, (error) => { logFailed ||= error !== undefined && error !== null; stderrDrained = true; checkGroup(); });
  else { stderrLog.end(() => { stderrDrained = true; checkGroup(); }); }
  checkGroup();
}
let launchReported = false;
function reportLaunch(value) {
  if (launchReported) return;
  launchReported = true;
  process.stderr.end(value + '\n');
}
function checkGroup() {
  if (finished) return;
  // The group is only worth inspecting once the task has exited and its logs have drained.
  // Polling while the task merely runs scans the whole process table every 25ms for the
  // task's entire lifetime, which costs a core and grows the anchor's heap for nothing.
  if (!taskExited || !stdoutDrained || !stderrDrained) return;
  // The anchor is spawned detached, so it leads its own group and everything the task launched is
  // in it. Draining means nobody but the anchor is left.
  readers.readGroupMembers(process.pid, (error, members) => {
    if (error) return setTimeout(checkGroup, 25);
    if (Date.now() >= anchorReadyAt && members.every((pid) => pid === process.pid)) {
      finished = true;
      process.exitCode = logFailed ? 1
        : taskExit.signal ? 128 + (signalNumbers[taskExit.signal] || 0) : (taskExit.code === null ? 1 : taskExit.code);
      return;
    }
    setTimeout(checkGroup, 25);
  });
}
const control = process.stdin;
control.setEncoding('utf8');
let controlData = '';
let decided = false;
function decide(command) {
  if (decided) return;
  decided = true;
  control.destroy();
  if (command === 'GO') launch();
  else if (spec.ignoreAbort === true) setInterval(() => {}, 1000);
  else process.exitCode = 0;
}
control.on('data', (chunk) => {
  controlData += chunk;
  const newline = controlData.indexOf('\n');
  if (newline >= 0) decide(controlData.slice(0, newline));
});
control.on('end', () => decide('ABORT'));
control.on('error', () => decide('ABORT'));
readers.readIdentity((error, identity) => {
  // A reading that does not make this process its own group leader is a reading of something other
  // than the anchor the supervisor spawned detached, and there is nothing safe to report about it.
  if (error || identity === null || identity.pgid !== process.pid) {
    process.stdout.end(); process.exitCode = 1; return;
  }
  process.stdout.end('READY ' + JSON.stringify(identity) + '\n');
});
` + anchorReaderSource;
