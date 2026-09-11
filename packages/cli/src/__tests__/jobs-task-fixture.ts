import type { WtmConfig } from '@wtm/core';

export function createQueueTaskFixture(releasePath: string): {
  config: WtmConfig;
  files: Record<string, string>;
} {
  return {
    config: { version: 1, tasks: { check: { run: ['node', 'queue-check.cjs', releasePath], queue: true, timeout: '10s' } } },
    // Each repository owns its task source, so the queue fingerprints the actual program.
    // JavaScript braces stay in this file and cannot be mistaken for WTM argv templates.
    files: {
      'queue-check.cjs': [
        "const fs = require('node:fs');",
        'const releasePath = process.argv[2];',
        "console.log('START ' + Date.now());",
        'const timer = setInterval(() => {',
        '  if (!fs.existsSync(releasePath)) return;',
        '  clearInterval(timer);',
        "  setTimeout(() => console.log('END ' + Date.now()), 100);",
        '}, 25);',
        '',
      ].join('\n'),
    },
  };
}
