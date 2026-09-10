# Endpoint batching and native follow-up — 2026-09-10

## Published wave evidence

The previous wave was submitted in one branch update with commits `8fea9e3`, `34b4a34`
and `1956dd5`. The connected GitHub account produced the published commit metadata;
all three trees and commit messages were compared with their local counterparts before
aligning the clean working branch. No PR, merge or release was performed.

[CI run 34455762258](https://github.com/0furkancolak/wtm/actions/runs/34455762258)
at `1956dd5` provides new evidence, distinct from the earlier container failures:

- Linux x64: 1619 passed, 0 failed, 14 existing skips; e2e 3/0 and binary smoke 9/0.
  Lint, typecheck, build and package verification passed. This includes the new queue RAM
  composition and real managed HTTP readiness lifecycle.
- macOS ARM64 and x64: each 1622 passed, 1 failed, 10 existing skips. Both failures are
  the new memory-composition fixture: its 111-byte canonical socket path exceeds macOS's
  104-byte limit. E2E/build/package/binary steps did not run after that failure.
- Windows x64 was still running when this follow-up was prepared; no result is inferred.

The macOS failure was reproduced locally with an intentionally long TMPDIR: 147 bytes
against Linux's 108-byte limit. The fixture now uses a unique short socket directory, as
the existing native lifecycle fixtures do. The same long-TMPDIR scenario passes after
the change. No production socket limit, ownership check or failing expectation changed.
This is a fixture fix with a local regression test, not a new green macOS CI claim.

## TODO 18 design and implementation

Keep the synchronous SQLite allocation transaction and existing lease/port ordering. Extend
the existing injectable probe function with an optional batch method, preserving single
candidate callers. Production Node and standalone probes supply that method. Each allocation
checks the compatible current lease first, then the preferred port and ascending range;
other active leases never reach the OS helper. The selected result is persisted before
releasing the transaction, preserving serialization between independent allocators.

One helper receives at most 256 candidates via stdin, at most 128 KiB. One two-second
parent deadline bounds all startup/bind/close work; SIGKILL prevents a SIGTERM-resistant
helper extending it. Binds run sequentially and release each successful endpoint. The
response is at most 4 KiB, with exactly one `available` boolean array aligned with the
request. Positions avoid ambiguity between different protocols/hosts sharing a port number.
The private CLI mode validates the full request before binding and rejects invalid UTF-8.

No failed, truncated, malformed, signalled or timed-out helper response authorizes a port.
Malformed injected batch vectors also leave existing leases unchanged. There is no new
daemon/service, dependency, persistent availability cache, public CLI flag or error code.
The public allocation error remains RUNTIME_PORT_UNAVAILABLE. Checking a port still cannot
prevent an external process from binding between the probe and actual task startup.

## Verification and limits

- Five new scenario tests initially failed against the old implementation (missing batching).
  The final tests cover preferred/stable order, lease exclusion, one-call budget exhaustion,
  malformed response rollback, one actual child invocation, failed/invalid responses and
  SIGTERM-resistant helper timeout, plus real busy/free TCP and UDP checks through Node
  and the actual private CLI entrypoint.
- 36 selected allocation, planning and internal CLI tests passed, including six independent
  SQLite allocator processes obtaining distinct persisted ports. Additional input validation
  tests reject oversized/non-UTF-8 requests without partial output or public CLI imports;
  the later selected internal/batch group passed 20/0.
- The first budget test asserted the public wrapper's cause as its top-level message.
  It was corrected to exercise the store's budget diagnostic directly; wrapper behavior
  and assertions about call count, candidate count and unchanged leases remain intact.
- Node 24.18.0 was installed in a separate tooling directory. The existing strict pinned
  version check was preserved; the new Linux x64 standalone executable built successfully.
  Its new native test passed: 256 candidates, no Node on the child's PATH, busy/free
  results and successful bind release. This is one targeted binary test, not a passed
  whole binary lifecycle suite in this container.
- Root reviewed the allocation/transport integration. Both subagents remain unavailable
  due to their usage quota. Independent review and this patch's native platform CI remain
  open; TODO 18 is deliberately not marked complete.

The expanded final selection passed 73/0 across eight files, including the real SQLite
store suite, CLI documentation parity and production memory composition. A subsequent
root review found that an installed legacy probe inherited batch mapping's extra callback
arguments and lost its first-free short circuit. A dedicated regression failed with three
arguments instead of one; installation now exposes batching only when the hook supplies it,
preserving the old behavior. That follow-up is part of the final validation below.

Final follow-up validation: all six batch scenarios passed, followed sequentially by lint,
full typecheck and package verification. No broad suite failure count from an earlier tree
is silently converted into a pass. The last full local test/e2e/performance outcomes remain
in the linked continuation ledger; the Linux CI pass above applies specifically to `1956dd5`.

Final checklist count: 14/45 numbered headings, 190/362 sub-checkboxes checked, five partial.
These ratios do not estimate remaining engineering effort. Multi-repo create/recovery,
platform completion, external distribution/signing, real two-AI memory measurements and
the other recorded P2/P3 product features still remain.
