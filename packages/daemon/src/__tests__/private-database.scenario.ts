import { chmod, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProductionDaemon } from '../runtime-factory';

const root = await mkdtemp(join(tmpdir(), 'wtm-private-database-'));
try {
  const dataRoot = join(root, 'data');
  await mkdir(dataRoot, { mode: 0o700 });
  const customDatabasePath = join(root, 'custom', 'nested', 'state.db');
  let created = false;
  try {
    const runtime = await createProductionDaemon({ dataRoot, databasePath: customDatabasePath });
    try { created = (await lstat(customDatabasePath)).isFile(); }
    finally { await runtime.close(); }
  } catch {
    created = false;
  }

  const unsafeParent = join(root, 'unsafe');
  await mkdir(unsafeParent, { mode: 0o700 });
  await chmod(unsafeParent, 0o755);
  let unsafeParentRejected = false;
  try {
    const runtime = await createProductionDaemon({ dataRoot, databasePath: join(unsafeParent, 'state.db') });
    await runtime.close();
  } catch {
    unsafeParentRejected = true;
  }
  process.stdout.write(`${JSON.stringify({ created, unsafeParentRejected })}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
