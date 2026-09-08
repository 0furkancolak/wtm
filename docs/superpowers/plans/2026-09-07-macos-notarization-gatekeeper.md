# Plan — Increment G, macOS notarization

Spec: `docs/superpowers/specs/2026-09-07-macos-notarization-gatekeeper.md`

**Executed 2026-09-07: Tasks 1, 2 and 3. Task 4 deliberately not done** — see this plan's own
"What to hand back if credentials are never added", which is exactly the situation reached. Task 1's
answer came from `xcrun notarytool submit --help` and `xcrun stapler staple --help` on this machine,
not from Apple's documentation site (it renders client-side and returned nothing readable); the
verified flags and the chosen secret names are recorded in the spec's "Credentials" section. Task 2
gained one thing the plan did not list: a real test of the step's shell
(`scripts/__tests__/release-notarization.test.ts`), because the spec's claim that the
credential-absent path stays buildable is otherwise only an assertion — `release-workflow.test.ts`
reads the YAML's shape, not what the shell in it decides.

Four tasks in sequence — each one gates the next, so this is not a parallel wave like
`2026-09-02-linux-in-ci.md`'s. Do them in order; do not start the workaround removal before the
gate is real and green.

## Task 1 — Verify the credential shape against current Apple docs

Before writing any workflow YAML, confirm (from Apple's current `notarytool` documentation, not
memory) which credential secrets this needs and the exact `xcrun notarytool submit` invocation
shape. The spec deliberately does not hardcode this. Record the chosen secret names in the spec's
own "Credentials" section if they differ from a first guess, so the next reader is not left
guessing which secrets to add in GitHub.

## Task 2 — Notarization step and packaging

Owns: `.github/workflows/release.yml` (`verify` job, after "Re-verify the signed executable").

1. Zip the signed executable into a temporary artifact for submission only (per the spec's
   packaging decision — the shipped `.tar.gz` does not change).
2. Add the `notarytool submit ... --wait` step, following the existing signing step's
   credential-absent fallback pattern (`release.yml:64-68`): missing credentials →
   `notarization=skipped` output, non-empty credentials → real submission, `notarization=notarized`
   or a failure that fails the step.
3. Add the `spctl -a -t execute -v` verification step described in the spec, right after.
4. Write `dist/release/NOTARIZATION` (mirrors `SIGNING`/`SMOKE.json` — see
   `release.yml:96-116`'s "Archive the signed executable" step) and export
   `WTM_RELEASE_NOTARIZATION` via `$GITHUB_ENV`, same shape as the existing `WTM_RELEASE_PERFORMANCE`
   heredoc export added for item 4.
5. Extend `publish`'s "Collect both architectures" step to merge both architectures'
   `staged/*/NOTARIZATION` into the combined gate's env var, same pattern as `SIGNING`'s
   single-value-across-both-architectures check (`release.yml:168-170`).

## Task 3 — The gate itself

Owns: `scripts/verify-release.ts`, `scripts/__tests__/verify-release.test.ts`,
`scripts/__tests__/release-workflow.test.ts`.

1. Add `verifyNotarization` per the spec, called from `verifyReleaseArtifacts` alongside
   `verifySmoke`/`verifySigning`/`verifyPerformance`.
2. Add `readNotarizationResult`/parsing helpers mirroring `readSmokeResults`/`readPerformanceResults`.
3. Wire `WTM_RELEASE_NOTARIZATION` into the `import.meta.main` CLI block.
4. Tests in `verify-release.test.ts`: rejects a release with no notarization evidence, rejects a
   stable release that is not notarized, accepts a prerelease that skipped notarization, accepts a
   stable release that is notarized. Follow item 4's four analogous tests
   (`scripts/__tests__/verify-release.test.ts`, "rejects a release without performance results" etc.)
   as the template — same shape, new variable.
5. Add `'WTM_RELEASE_NOTARIZATION'` to `release-workflow.test.ts`'s `required` array (the same test
   item 4 already extended for `WTM_RELEASE_PERFORMANCE`).
6. Run the full local gate (`bun run lint`, `typecheck`, `test`, `test:e2e`) — this task is pure
   TypeScript/test work and should be fully verifiable locally even without real Apple credentials,
   since every test exercises the parsing/gating logic with fixture env-var values, not a real
   `notarytool` call.

## Task 4 — Remove the workaround (only after Task 2 and 3 are merged and green)

Owns: `README.md`, `CHANGELOG.md`, `scripts/__tests__/gatekeeper-workaround.test.ts` (deleted),
`todo.md` (items 5 and 36).

1. Delete the marked regions in `README.md` and `CHANGELOG.md`.
2. Delete `scripts/__tests__/gatekeeper-workaround.test.ts` in the same commit.
3. Run `bun run test` — deleting the guard test should not be the thing that makes the suite pass;
   the workaround text should already be gone before this step, or the guard test would have failed
   first.
4. `todo.md`: flip item 5's checkboxes and item 36's remaining line to `[x]`, with a closing note
   naming the real evidence (which CI run's `spctl --assess` passed, which secrets were configured).
   Do not flip either header to `[x]` on the strength of local-only testing — per the spec's own
   closing section, the true acceptance criterion needs a real tagged release run with real
   credentials, which only the user can trigger by adding the GitHub secrets and pushing a tag.

## What to hand back if credentials are never added

If this plan is executed without the user ever adding Apple credentials as secrets, Tasks 2 and 3
are still real, mergeable, gated-correctly work (a stable release will correctly refuse to publish
without notarization — it just also won't have notarization available yet, so stable releases stay
blocked until credentials exist). Task 4 cannot close honestly without a real green
`spctl --assess` from an actual notarized artifact — leave the workaround in place and say so in
`todo.md`, the same way item 9's Windows section documents a deliberately incomplete close rather
than a fabricated one.
