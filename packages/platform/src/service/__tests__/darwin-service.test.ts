/**
 * The macOS descriptor, checked at the seam the generalisation introduced.
 *
 * The plist body, the label and the `launchctl` argument vectors are already asserted by
 * `packages/daemon/src/__tests__/launchd.test.ts`, which was not modified by that generalisation
 * and is the real evidence that macOS behaves as it did. What is new here is the descriptor's
 * *shape* -- the directory plan the lifecycle now reads instead of the four hardcoded
 * `ensureSafeChildDirectory` calls it used to make -- and this pins it to what those calls did.
 */
import { describe, expect, test } from 'bun:test';
import { darwinPlatformPaths } from '../../paths';
import { darwinServiceBackend, launchdLabelFor } from '../darwin';

const home = '/Users/test';
const paths = darwinPlatformPaths({ home, env: {} });

describe('launchd descriptor', () => {
  test('publishes into LaunchAgents under the derived label', () => {
    expect(darwinServiceBackend.definitionPath({ serviceRoot: paths.serviceRoot, label: launchdLabelFor(home) }))
      .toBe(`/Users/test/Library/LaunchAgents/${launchdLabelFor(home)}.plist`);
    expect(darwinServiceBackend.definitionSuffix).toBe('.plist');
  });

  test('has no reload and no disable, which is what keeps the macOS command sequence unchanged', () => {
    // launchd reads the definition at bootstrap time and has no registration to undo. Both
    // commands being absent is what makes every systemd-only step in the shared lifecycle a
    // no-op here rather than an extra `launchctl` call.
    const commands = darwinServiceBackend.commands({
      uid: 501,
      label: launchdLabelFor(home),
      definitionPath: `/Users/test/Library/LaunchAgents/${launchdLabelFor(home)}.plist`,
    });
    expect(commands.reload).toBeUndefined();
    expect(commands.disable).toBeUndefined();
  });

  test('plans the same directories, in the same order, that the install used to create inline', () => {
    // `~/Library` is the user's own and must stay group- and other-readable; the three leaves
    // hold this daemon's definition, its database and its logs and must not.
    const plan = darwinServiceBackend.directories({
      home, serviceRoot: paths.serviceRoot, dataRoot: paths.dataRoot, logRoot: paths.logRoot,
    });
    expect(plan.root).toBe(home);
    expect(plan.definition).toEqual([
      { path: '/Users/test/Library', ownerOnly: false },
      { path: '/Users/test/Library/LaunchAgents', ownerOnly: true },
    ]);
    expect(plan.install).toEqual([
      { path: '/Users/test/Library', ownerOnly: false },
      { path: '/Users/test/Library/LaunchAgents', ownerOnly: true },
      { path: '/Users/test/Library/Application Support', ownerOnly: false },
      { path: '/Users/test/Library/Application Support/WTM', ownerOnly: true },
      { path: '/Users/test/Library/Logs', ownerOnly: false },
      { path: '/Users/test/Library/Logs/WTM', ownerOnly: true },
    ]);
  });

  test('carries the legacy migration, which is the one thing Linux does not', () => {
    expect(darwinServiceBackend.legacyMigration?.label).toBe('dev.wtm.daemon');
  });
});
