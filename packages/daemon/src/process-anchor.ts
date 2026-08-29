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

const anchorSource = String.raw`
'use strict';
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const { closeSync } = fs;
const { createHash } = require('node:crypto');
const { Writable, pipeline } = require('node:stream');
const pathModule = require('node:path');
const spec = JSON.parse(process.env.WTM_ANCHOR_SPEC || '{}');
delete process.env.WTM_ANCHOR_SPEC;
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
    taskExited = true; taskExit = { code: 127, signal: null };
  });
  child.once('exit', (code, signal) => { taskExited = true; taskExit = { code, signal }; });
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
  const inspector = execFile('ps', ['-axo', 'pid=', '-o', 'pgid=', '-o', 'state='], {
    encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', LANG: 'C' }, maxBuffer: 4 * 1024 * 1024,
    timeout: 1000
  }, (error, stdout) => {
    if (error) return setTimeout(checkGroup, 25);
    const members = stdout.split(/\r?\n/).flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
      return match && Number(match[2]) === process.pid && !match[3].startsWith('Z') ? [Number(match[1])] : [];
    });
    if (taskExited && stdoutDrained && stderrDrained && Date.now() >= anchorReadyAt
      && members.every((pid) => pid === process.pid || pid === inspector.pid)) {
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
execFile('ps', [
  '-ww', '-p', String(process.pid), '-o', 'pgid=', '-o', 'state=', '-o', 'lstart=', '-o', 'comm=', '-o', 'command='
], {
  encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', LANG: 'C' }, maxBuffer: 64 * 1024, timeout: 1000
}, (error, stdout) => {
  if (error) { process.stdout.end(); process.exitCode = 1; return; }
  const line = stdout.split(/\r?\n/).find((value) => value.trim().length > 0) || '';
  const match = /^\s*(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
  if (!match || Number(match[1]) !== process.pid) { process.stdout.end(); process.exitCode = 1; return; }
  const marker = /(?:^|\s)([a-f0-9]{64})\s*$/.exec(match[5])?.[1];
  const fingerprint = createHash('sha256').update(match[4]).update('\0')
    .update(marker ? 'wtm-anchor:' + marker : match[5]).digest('hex');
  const identity = {
    pid: process.pid, pgid: Number(match[1]), processStartTime: match[3], commandFingerprint: fingerprint
  };
  process.stdout.end('READY ' + JSON.stringify(identity) + '\n');
});
`;
