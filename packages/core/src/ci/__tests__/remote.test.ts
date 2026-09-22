import { describe, expect, test } from 'bun:test';
import { ciRepositoryFromSlug, parseCiRemote } from '../remote';

describe('parseCiRemote', () => {
  const github = { host: 'github.com', owner: 'acme', name: 'widgets', slug: 'github.com/acme/widgets' };
  test.each([
    ['https://github.com/acme/widgets.git', github],
    ['https://github.com/acme/widgets', github],
    ['https://github.com/acme/widgets/', github],
    ['https://x-access-token:secret@github.com/acme/widgets.git', github],
    ['http://GitHub.com/acme/widgets.git', github],
    ['git@github.com:acme/widgets.git', github],
    ['git@github.com:acme/widgets', github],
    ['ssh://git@github.com/acme/widgets.git', github],
    ['ssh://git@github.com:22/acme/widgets', github],
    ['git@ghe.corp.example:platform/api.git', { host: 'ghe.corp.example', owner: 'platform', name: 'api', slug: 'ghe.corp.example/platform/api' }],
  ])('%s', (remote, expected) => {
    expect(parseCiRemote(remote)).toEqual(expected);
  });

  test.each([
    [null], [''], ['/srv/git/widgets.git'], ['file:///srv/git/widgets.git'], ['C:/repos/widgets'],
    ['https://gitlab.com/group/subgroup/project.git'], ['https://github.com/acme'], ['github.com:acme/widgets'],
    // scp-style syntax lets almost anything but `:`, whitespace and `/` through as the host; a
    // hostile remote must not be able to smuggle a flag-shaped or malformed value into it.
    ['git@--hostname:acme/widgets'], ['git@ho$t.example:acme/widgets'], ['git@host,name:acme/widgets'],
    ['git@-leading-hyphen.example:acme/widgets'], ['git@trailing-hyphen-.example:acme/widgets'],
  ])('refuses %s', (remote) => {
    expect(parseCiRemote(remote)).toBeNull();
  });

  test('accepts a bracketed IPv6 host', () => {
    expect(parseCiRemote('ssh://git@[2001:db8::1]/acme/widgets.git')).toEqual({
      host: '[2001:db8::1]', owner: 'acme', name: 'widgets', slug: '[2001:db8::1]/acme/widgets',
    });
  });

  test('round-trips a slug', () => {
    expect(ciRepositoryFromSlug('github.com/acme/widgets')).toEqual(github);
    expect(ciRepositoryFromSlug('acme/widgets')).toBeNull();
  });
});
