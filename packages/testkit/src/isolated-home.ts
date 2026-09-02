import { join } from 'node:path';

/**
 * The environment that confines WTM to `home`, on every supported platform.
 *
 * On macOS, setting `HOME` is enough: every path WTM writes derives from `~/Library`, so a
 * fixture that hands a temporary home to a child has, by construction, isolated it.
 *
 * On Linux it is not enough, and the difference is not cosmetic. `XDG_STATE_HOME`,
 * `XDG_CONFIG_HOME` and `XDG_RUNTIME_DIR` are read from the ambient environment and *override*
 * the `HOME`-derived defaults (`platform-paths.ts:58-72`). A CI runner exports
 * `XDG_RUNTIME_DIR`. So a test that spreads `process.env` and overrides only `HOME` resolves its
 * daemon socket to the runner's real `/run/user/<uid>/wtm/wtmd.sock` — an address shared with
 * every other test in the run, and outside the directory the fixture deletes afterwards. The
 * suite runs single-threaded today, which makes that survivable rather than correct; it stops
 * being survivable the moment anything runs in parallel.
 *
 * `XDG_DATA_HOME` and `XDG_CACHE_HOME` are set although WTM reads neither. The claim this helper
 * makes is that *no* XDG variable can send WTM outside `home`, and a helper that enumerated only
 * the variables the product happens to read today would stop being true the first time one was
 * added — silently, and only on Linux.
 *
 * Nothing is created here. WTM makes its own directories with the modes it requires
 * (`server.ts:659` creates the socket parent 0700, recursively), and a fixture that pre-created
 * them would be testing its own `mkdir` rather than the product's.
 */
export function isolatedHomeEnvironment(home: string): Record<string, string> {
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    // Deliberately set rather than unset. Leaving it absent also isolates — the socket falls back
    // to the data root under `home` — but it would mean every Linux test exercised the fallback
    // and none exercised the path a real login session takes. Under `home` it also stays far
    // shorter than the fallback, which is the difference between fitting in a 108-byte socket
    // address and not.
    XDG_RUNTIME_DIR: join(home, 'run'),
  };
}
