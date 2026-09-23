import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { extensionfulRelativeImportSpecifiers } from './lint-rules';

const root = resolve(import.meta.dir, '..');
const violations: string[] = [];
for (const path of await files(root)) {
  const projectPath = relative(root, path);
  if (/\.(?:test|scenario)\.ts$/.test(path) && !projectPath.split(sep).includes('__tests__')) {
    violations.push(`${projectPath}: tests and scenarios must be under __tests__`);
  }
  if (!/\.[cm]?[jt]sx?$/.test(path)) continue;
  const source = await readFile(path, 'utf8');
  for (const specifier of extensionfulRelativeImportSpecifiers(source)) {
    violations.push(`${projectPath}: extensionful relative import ${specifier}`);
  }
}
if (violations.length > 0) {
  process.stderr.write(`${violations.join('\n')}\n`);
  process.exitCode = 1;
}

async function files(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', '.superpowers', 'artifacts', 'coverage', 'dist', 'node_modules'].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...await files(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}
