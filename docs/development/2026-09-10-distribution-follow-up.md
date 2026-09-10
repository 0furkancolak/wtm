# Release evidence and local Linux archives — 2026-09-10

This slice follows the frozen runtime validation in
[the review ledger](2026-09-10-review-follow-up.md). Root owns the verifier and integration;
one subagent owns archive construction, while the other independently reviews it. Root runs
all tests and builds sequentially. No tag, release, registry publication or service operation
is part of this work.

## Release evidence

The performance gate accepted numeric values without validating their domain. A negative report
could cancel a different architecture's blocker; fractional, infinite or unsafe integers could
also enter through the JSON/public API boundary. Both boundaries now require non-negative safe
integers for blockers and warnings. Aggregation uses BigInt, preserving exact diagnostic counts.
Malformed evidence is rejected for prereleases too; the valid prerelease blocker exemption is
unchanged. Four regressions failed before repair, including a real executable JSON-input check.

Two further regressions showed that empty, duplicated or unpublished archive selections could
pass. Selection must now be a nonempty, unique subset of the configured published targets. The
default gate still requires both Darwin archives, while each Darwin build can gate only its own
archive. Verifier/workflow tests passed 50/0 after repair; independent review found no remaining
issue. The shared catalog integration also passed review.

## Local archive contract

`scripts/artifact-targets.ts` defines Darwin arm64, Darwin x64 and Linux x64 local targets.
Only the two Darwin entries belong to the published target list. Unsupported targets fail
before reading or changing files. Existing Darwin archive names, Mach-O classification and
tar arguments remain unchanged; Linux uses GNU tar with numeric owner/group zero.

Linux classification reads at most 64 bytes and checks ELF64, little-endian encoding, version,
executable/PIE type, x86-64 machine and header size. This is architecture evidence, not proof
that an arbitrary payload executes. Staging contains exactly `wtm`, `LICENSE`, `NOTICE` and
`THIRD_PARTY_LICENSES.md`, with mode 0755 for `wtm`; SHA256SUMS records the actual archive digest.
Archive/checksum replacement is not a newly promised atomic transaction. Linux ARM64, Windows
ZIP, additional release runners and their signing policies remain open.

The existing implementation failed 19 new behavior checks before repair (8 passed). Independent
review then identified a blocking FIFO open before the byte limit could apply. A real FIFO child
printed READING and timed out after 2.5 seconds without a writer. Nonblocking open followed by
descriptor-based regular-file validation fixed it; every exit closes the descriptor. The same
test now returns explicit refusal in about 44 ms. Independent re-review is clear.

## Verification and limits

- Final archive/catalog/verifier/workflow/Homebrew/SEA-builder/CLI-document group:
  **122 passed, 0 failed, 1 existing Ruby-availability skip**, 423 assertions in nine files.
  The real FIFO and Linux archive tests ran and passed. Their native platform conditions do
  not replace the portable target/header tests on other hosts.
- Strict TypeScript checking of changed release scripts and their tests passed with the
  repository's strict/noUncheckedIndexedAccess/exactOptionalPropertyTypes settings.
- A real small Linux ELF fixture was archived/extracted and checked for exact bytes, four
  members, numeric owner/group, mode and digest. This alone is not WTM acceptance evidence.
- The already-built WTM SEA was separately passed to the native archive scenario. The resulting
  archive was **40,575,515 bytes**; extraction preserved executable SHA-256
  `9742de3cebbdb255ffca5662d269652708d62f9097fbc3cbbd0bf140f1028221`, all four members and mode
  0755. Its `--version` returned `0.1.0-rc.1` with exit code 0. No additional SEA build ran.
  This proves local construction/extraction/version smoke, not daemon or Windows acceptance.

Distribution documentation now separates four configured CI runners from two Darwin release
jobs, optional npm publication from a verified registry channel, and local packaging from
published assets. README/CONTRIBUTING purge instructions follow the Makefile's macOS state/log
and Linux XDG state/config roots. The quarantine workaround remains. The user's machine,
Apple credentials, native Windows acceptance, registry installation and additional platform
release artifacts are not established by this slice.
