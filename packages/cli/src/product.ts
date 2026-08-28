import type { Command } from 'commander';
import metadata from '../../../package.json' with { type: 'json' };

export const WTM_VERSION = metadata.version;
export const WTM_BRAND = 'Powered by https://nafru.com' as const;

export function configureProductMetadata(program: Command): Command {
  return program.version(`${WTM_VERSION}\n${WTM_BRAND}`).addHelpText('after', `\n${WTM_BRAND}\n`);
}
