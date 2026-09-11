import { writeSync } from 'node:fs';
import { createReleaseHost } from '../release-artifacts';

const target = process.argv[2];
if (target === undefined) throw new Error('A header input path is required');
// This synchronous marker proves a timed-out child reached the operation under review.
writeSync(1, 'READING\n');
try {
  const bytes = createReleaseHost().readPrefix(target, 64);
  process.stdout.write(`${JSON.stringify({ accepted: true, bytes: bytes.byteLength })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ accepted: false,
    message: error instanceof Error ? error.message : String(error) })}\n`);
}
