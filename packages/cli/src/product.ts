import type { Command } from 'commander';
// Importing the single field keeps the whole manifest out of the shipped bundles.
import { version } from '../../../package.json' with { type: 'json' };

export const WTM_VERSION = version;
export const WTM_BRAND = 'Powered by https://nafru.com' as const;

export function configureProductMetadata(program: Command): Command {
  // Attribution belongs in help, where a reader is already asking about the tool.
  // `--version` stays a single machine-readable line, as every other CLI's does.
  return program.version(WTM_VERSION).addHelpText('after', `\n${WTM_BRAND}\n`);
}
