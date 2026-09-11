import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

interface LinuxMountBoundaries {
  /** Strict descendants only: a worktree may itself be a mount root. */
  paths: ReadonlySet<string>;
  /** Stable identities of mounts containing or contained by this worktree. */
  fingerprint: string;
}

const maxMountInfoBytes = 1024 * 1024;
const maxMountInfoRecords = 20_000;

/**
 * st_dev cannot identify same-filesystem bind mounts. Read this process's mount namespace,
 * with fixed allocation and record limits, instead of following those mountpoints. The caller
 * compares snapshots around its walk; this does not promise an atomic mount/filesystem view.
 * Format: https://docs.kernel.org/filesystems/proc.html#proc-pid-mountinfo-information-about-mounts
 */
export async function readLinuxMountBoundaries(root: string, checkBudget: () => void): Promise<LinuxMountBoundaries> {
  checkBudget();
  const handle = await open('/proc/self/mountinfo', 'r');
  let value: string;
  try {
    const buffer = Buffer.allocUnsafe(maxMountInfoBytes + 1);
    let length = 0;
    while (true) {
      checkBudget();
      const { bytesRead } = await handle.read(buffer, length, Math.min(64 * 1024, buffer.length - length), null);
      length += bytesRead;
      if (length > maxMountInfoBytes) throw new Error('Mount evidence exceeds its byte budget.');
      if (bytesRead === 0) break;
    }
    value = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  } finally { await handle.close(); }
  checkBudget();
  if (!value.endsWith('\n')) throw new Error('Incomplete mount evidence.');
  const lines = value.slice(0, -1).split('\n');
  if (lines.length === 0 || lines.length > maxMountInfoRecords) throw new Error('Invalid mount record count.');
  const ids = new Set<string>();
  const paths = new Set<string>();
  const relevant: string[] = [];
  let containingMount = false;
  for (const line of lines) {
    checkBudget();
    const fields = line.split(' ');
    const separator = fields.indexOf('-');
    // Unknown optional fields are allowed by the kernel contract; malformed fixed fields
    // cannot be ignored, even on unrelated mounts, because an omitted boundary is unsafe.
    if (separator < 6 || fields.length !== separator + 4 || fields.some((field) => field === '')
      || !positiveInteger(fields[0]!) || !positiveInteger(fields[1]!)
      || !/^\d+:\d+$/.test(fields[2]!) || ids.has(fields[0]!)) throw new Error('Invalid mount record.');
    ids.add(fields[0]!);
    decodePath(fields[3]!);
    const mountpoint = decodePath(fields[4]!);
    if (contains(mountpoint, root)) containingMount = true;
    if (contains(root, mountpoint) || contains(mountpoint, root)) relevant.push(line);
    if (mountpoint !== root && contains(root, mountpoint)) paths.add(mountpoint);
  }
  if (!containingMount) throw new Error('Mount evidence does not cover the worktree.');
  // File order and mounts elsewhere in the namespace do not affect this estimate. Include
  // the complete relevant records, so remount/options/parent/root changes still invalidate it.
  relevant.sort();
  return { paths, fingerprint: createHash('sha256').update(relevant.join('\n')).digest('hex') };
}

function decodePath(value: string): string {
  if (/\\(?!040|011|012|134)/.test(value)) throw new Error('Invalid mount path escape.');
  const decoded = value.replace(/\\(040|011|012|134)/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
  if (!isAbsolute(decoded) || decoded.includes('\0')) throw new Error('Invalid mount path.');
  return resolve(decoded);
}

function positiveInteger(value: string): boolean {
  return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
}

function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
