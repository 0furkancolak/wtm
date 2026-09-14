/** A CI provider repository, as `gh --repo` names it: `host/owner/name`. */
export interface CiRepository {
  host: string;
  owner: string;
  name: string;
  slug: string;
}

const segment = /^[A-Za-z0-9_.-]+$/;

function repository(host: string, path: string): CiRepository | null {
  const parts = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '').split('/');
  if (parts.length !== 2) return null;
  const [owner, name] = parts as [string, string];
  if (!segment.test(owner) || !segment.test(name) || host.length === 0) return null;
  const lower = host.toLowerCase();
  return { host: lower, owner, name, slug: `${lower}/${owner}/${name}` };
}

/**
 * The repository a `remote.origin.url` names, or null when it names no hosted `owner/name`
 * repository (a local path, `file://`, or a nested GitLab group). Credentials in the URL are
 * discarded, never returned.
 */
export function parseCiRemote(remote: string | null): CiRepository | null {
  if (remote === null) return null;
  const value = remote.trim();
  if (/^(?:https?|ssh):\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return repository(url.hostname, url.pathname);
    } catch {
      return null;
    }
  }
  const scp = /^[^@\s/]+@([^:\s/]+):(.+)$/.exec(value);
  return scp === null ? null : repository(scp[1]!, scp[2]!);
}

export function ciRepositoryFromSlug(slug: string): CiRepository | null {
  const [host, ...rest] = slug.split('/');
  return host === undefined ? null : repository(host, rest.join('/'));
}
