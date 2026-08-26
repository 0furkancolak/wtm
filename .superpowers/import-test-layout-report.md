# Import and Test Layout Refactor Report

Baseline: `f49046f0080a30fcbd3d547a62347caeda7df83f`

## Changes

- Set `module` to `Preserve` and `moduleResolution` to `Bundler` in `tsconfig.base.json`, retaining all strict compiler settings.
- Removed filename extensions from every relative static import, dynamic import, and re-export specifier in `packages/**/*.ts`.
- Moved all test files under a local `__tests__` directory and corrected their relative imports:
  - `packages/protocol/src/{adapter,errors,ipc,json-envelope}.test.ts` → `packages/protocol/src/__tests__/`
  - `packages/core/src/config/{load,merge,provenance,schema}.test.ts` → `packages/core/src/config/__tests__/`
  - `packages/core/src/git/{git-runner.integration,worktree-parser}.test.ts` → `packages/core/src/git/__tests__/`
  - `packages/core/src/templates/resolve.test.ts` → `packages/core/src/templates/__tests__/`

## Verification

| Command | Result |
| --- | --- |
| `bun test` | Passed: 32 tests, 0 failures, 48 expectations across 11 files. |
| `bun run typecheck` | Passed: protocol, core, and testkit TypeScript projects. |
| `bun run build` | Passed: produced `dist/protocol/index.js` and `dist/core/index.js`. |
| Node dist import smoke test | Passed: both bundles imported; `protocolVersionSchema.parse` and `resolveWorkspaceConfig` were available. |
| Relative-import extension audit | Passed: 0 matching relative specifiers with a filename extension. |
| Test placement audit | Passed: 0 `*.test.ts` files outside a `__tests__` path. |
| `git diff --check` | Passed with no whitespace errors. |

## Self-review

- Package specifiers, Node built-in specifiers, and behavior were not changed.
- The integration test's testkit reference remains a relative import because the package export map does not expose `./git-fixture`; its path was adjusted after the move.
- Changes are limited to TypeScript module-resolution configuration, relative import specifiers, and test-file location/import updates.

## Concerns

None. Bun tests, TypeScript Bundler resolution, Bun builds, and Node imports of the generated bundles all validate the requested layout.
