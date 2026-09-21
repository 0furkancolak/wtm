# Adapter authoring guide

This is a practical walkthrough for writing an **external** adapter — one that lives outside the
WTM monorepo and speaks the wire protocol from [`docs/06-adapter-protocol.md`](06-adapter-protocol.md).
Read that document for the protocol itself (operations, timeouts, the V1 single-file format, the
trust model); this guide only covers using `@wtm/adapter-sdk` to implement it without hand-rolling
the stdin/stdout loop.

## What the SDK is, and isn't

`@wtm/adapter-sdk` (`packages/adapter-sdk` in this repo) is a thin, protocol-only wrapper: it
re-exports the request/response types and Zod schemas from `@wtm/protocol`, adds a `defineAdapter`
helper for type-checking your handlers, and a `runAdapter` function that implements the "read one
JSON request from stdin, write one JSON response to stdout" loop `docs/06` specifies. It depends on
nothing platform-specific and contains no WTM internals.

It is **not yet published to npm.** Until it is, vendor `packages/adapter-sdk/src` directly (it is
plain TypeScript with a single dependency on `@wtm/protocol`, also unpublished) into your adapter's
build, or copy the handful of exported functions verbatim — they are small and stable. The gap is
a follow-up on the same npm-publishing decision already pending for the WTM CLI package itself
(`todo.md` item 38a).

More importantly: the SDK is a **build-time** dependency, not a runtime one. `docs/06`'s trust
model requires a single self-contained file with zero non-`node:` imports — so whatever you import
from `@wtm/adapter-sdk` (or anywhere else) must be bundled into that one file by your own build step
(esbuild, rollup, tsup, or similar), not `import`ed by the file WTM actually executes.

## Writing an adapter

```ts
import { defineAdapter, runAdapter } from '@wtm/adapter-sdk';

const adapter = defineAdapter({
  metadata: () => ({
    id: 'cargo',
    name: 'Cargo',
    version: '1.0.0',
    kind: 'package-manager',
    provides: ['rust.package-manager', 'rust.build-system'],
  }),

  detect: async (context) => {
    // context.repository.root, context.worktree.root, etc. — see docs/06's "Detection" section.
    return { detected: false, confidence: 0, evidence: [] };
  },

  plan: async (context) => ({
    resources: [],
    actions: [],
    capabilities: {},
    tasks: {},
  }),

  // `code` on each finding comes from @wtm/protocol's shared `WtmErrorCode` enum, the same
  // fixed list every WTM-side error uses -- it is not a freeform string. Reuse one of the
  // existing `ADAPTER_*` codes (`ADAPTER_DETECTION_AMBIGUOUS`, `ADAPTER_PLAN_CONFLICT`) where it
  // fits; there is no adapter-defined-code escape hatch in V1.
  doctor: async (context) => [],

  // Optional — omit it if your adapter never declares a resource that needs deleting.
  // cleanupPlan: async (context) => ({ actions: [] }),
});

process.exitCode = (await runAdapter(adapter)) ? 0 : 1;
```

`defineAdapter` does nothing at runtime — it exists purely so TypeScript checks your handler object
against the `AdapterHandlers` interface before you bundle it. `runAdapter` does the actual work:
it reads stdin to completion, validates the request against `adapterRequestSchema`, checks the
protocol version, calls the matching handler, and writes the JSON response WTM expects — wrapping
`metadata` in its `{ protocol, adapter }` envelope and `doctor`'s array in `{ findings }`, since
those are the two operations whose wire shape differs from the shape a handler returns. A thrown
error or a request that fails validation is reported on stderr, never a crash with a stack trace on
stdout, and `runAdapter` resolves to `false` rather than throwing or touching `process.exitCode`
itself — set the real exit code from its result in your entry file, as above.

## Bundling into the V1 single-file format

The two lines `docs/06` requires must be the literal first two lines of the file WTM hashes and
executes:

```text
#!/usr/bin/env node
// wtm-adapter-v1: self-contained
```

Point your bundler at an entry file that calls `runAdapter`, output a single ESM file, and prepend
those two lines (most bundlers will let you inject a banner; otherwise concatenate them onto the
bundler's output as a build step). The bundled file must not `import` anything outside Node's own
`node:*` built-ins at runtime — `docs/06`'s "V1 external executable format" section explains why
(a trust record authenticates exactly one file's bytes) and lists the built-ins that are actually
reachable at execution time.

## Testing locally

`@wtm/adapter-sdk/testing` exports `invokeAdapter`, a small harness for exercising a built adapter
file without going through `wtm adapter trust` first:

```ts
import { invokeAdapter } from '@wtm/adapter-sdk/testing';

const result = await invokeAdapter('./dist/wtm-adapter-cargo.mjs', {
  operation: 'detect',
  context: {
    workspace: { root: '/tmp/workspace' },
    repository: { root: '/tmp/workspace/app', mainRoot: '/tmp/workspace/app' },
    worktree: { root: '/tmp/workspace/app', id: 1, branch: 'main' },
  },
});

if (result.ok) {
  console.log(result.response); // validated against the same schema WTM's daemon uses
} else {
  console.error(result.reason, result.detail, result.stderr);
}
```

This spawns `node <your-file>` directly, sends one JSON request on stdin, and validates whatever
comes back on stdout against `@wtm/protocol`'s response schema for that operation — the same check
WTM performs after a real invocation. It is a development-time check, not a substitute for the real
path: it does not exercise WTM's verify-then-execute-by-descriptor trust machinery, so passing it
proves your adapter speaks the protocol correctly but not that the file itself will pass
`wtm adapter trust`'s format check. Run that against the actual bundled artifact before shipping.

## Trusting and running your adapter

Once built and placed in a repository, an external adapter is not executed until explicitly
trusted:

```bash
wtm adapter trust <adapter-id> ./dist/wtm-adapter-cargo.mjs
```

See [`docs/04-cli-reference.md`](04-cli-reference.md#wtm-adapter-list) for `wtm adapter list` /
`trust` / `untrust`, and [`docs/06-adapter-protocol.md`](06-adapter-protocol.md#trust-model) for
what trust actually authenticates (adapter ID, canonical path, and a SHA-256 of the exact bytes —
a changed file needs re-trusting, which `wtm adapter untrust` never blocks).
