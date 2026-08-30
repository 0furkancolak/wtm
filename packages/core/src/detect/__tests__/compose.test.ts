import { describe, expect, it } from 'bun:test';
import { parseComposeServices } from '../compose';

describe('compose reading', () => {
  it('reads published ports and the addresses one service holds for another', () => {
    const services = parseComposeServices([
      'version: "3.9"',
      'services:',
      '  api:',
      '    build: ./api',
      '    ports:',
      '      - "4000:4000"',
      '    environment:',
      '      DATABASE_URL: postgres://db:5432/app',
      '  web:',
      '    ports:',
      '      - 127.0.0.1:5173:5173',
      '    depends_on:',
      '      - api',
      '    environment:',
      '      - VITE_API_URL=http://api:4000',
      '  db:',
      '    image: postgres:16',
    ].join('\n'));

    expect(services).toEqual([
      { name: 'api', published: [4000], urls: [] },
      { name: 'web', published: [5173], urls: [{ name: 'VITE_API_URL', url: 'http://api:4000' }] },
      { name: 'db', published: [], urls: [] },
    ]);
  });

  it('reads nothing out of a file with no services block', () => {
    expect(parseComposeServices('name: app\nvolumes:\n  data:\n')).toEqual([]);
  });

  it('leaves a service alone rather than guessing at an unfamiliar shape', () => {
    const services = parseComposeServices([
      'services:',
      '  api:',
      '    ports: !reset []',
      '    environment:',
      '      SECRET: hunter2',
    ].join('\n'));

    expect(services).toEqual([{ name: 'api', published: [], urls: [] }]);
  });
});
