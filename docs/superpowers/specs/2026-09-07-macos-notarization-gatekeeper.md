# Increment G — macOS notarization

## Status

Tasks 1–3 implemented — 2026-09-07. Task 4 (removing the quarantine workaround) is deliberately
**not** done: it cannot close honestly without a real notarized artifact, and no Apple credentials
exist as GitHub secrets yet. See "Credentials" for what to add and "What this increment cannot
verify without the user" for what remains.

What landed: the `notarize` step in `release.yml`'s `verify` job (both credential shapes, the
`spctl --assess` check, `dist/release/NOTARIZATION`), `verifyNotarization` in
`scripts/verify-release.ts` reading `WTM_RELEASE_NOTARIZATION`, the combined-gate merge in
`publish`, and `scripts/__tests__/release-notarization.test.ts`, which runs the step's real shell
against a scripted `notarytool`/`spctl` so every branch — including the credential-absent one a
contributor hits — is proven without contacting Apple.

Originally named and scoped one paragraph deep in
`docs/superpowers/specs/2026-08-31-v1-stable-program-map.md:160-165`:

> Covers item 5 and closes item 36's temporary workaround. Exit: stable macOS artifacts pass
> Gatekeeper on a clean machine; publication is blocked without successful notarization.

This document is that increment's actual design. It closes `todo.md` items 5 and 36 together,
because 36's own acceptance criteria explicitly defer to 5:

> Kalıcı çözüm için 5. maddeye (Developer ID + notarization) bağla. ... Notarization
> tamamlandığında bu geçici çözüm dokümandan kaldırılıyor. Kalan tek kriter bu.

## Problem, with real evidence

`spctl -a -t execute wtm` on a clean machine rejects the ad-hoc/Developer-ID-signed executable
(`source=no usable signature` for ad-hoc; a bare Developer-ID signature without notarization fares
no better on a *fresh* download once the quarantine bit is set — the kernel `SIGKILL`s at `exec`,
before any WTM code runs, with no stdout/stderr). `todo.md` item 36 already root-caused this fully
and shipped the only thing possible without notarization: a documented `xattr -d
com.apple.quarantine wtm` workaround, delimited by `<!-- gatekeeper-quarantine:start/end -->`
markers in `README.md` and `CHANGELOG.md`, guarded by
`scripts/__tests__/gatekeeper-workaround.test.ts` so the workaround cannot be half-removed later.

Today's signing step (`.github/workflows/release.yml:56-82`) only runs `codesign`. There is no
`xcrun notarytool` call anywhere in the repository. A stable release currently publishes with
`signing=signed` (or `adhoc` for a prerelease) and nothing checks notarization at all.

## Decision

### Credentials

**Verified 2026-09-07 against the tool itself** (`xcrun notarytool 1.1.2 (41)`), not against
documentation or memory — Apple's own documentation page renders client-side and could not be read,
and `--help` is the authority the workflow actually runs against anyway:

```text
-k, --key <key>        App Store Connect API key. File system path to the private key.
-d, --key-id <key-id>  App Store Connect API Key ID.
-i, --issuer <issuer>  App Store Connect API Issuer ID, UUID format. Required for Team API
                       Keys. Do not provide for Individual API Keys.
    --apple-id <apple-id> / --password <password> / --team-id <team-id>
    --wait/--no-wait   Wait until processing is complete. (default: false)
    --timeout <duration>
-f, --output-format    ["normal", "json", "plist"]
```

Both shapes are still accepted, so the step supports both and prefers the API key. The `--issuer`
line is the one detail worth carrying forward: it is *required* for a team key and must be
*omitted* for an individual one, so the step passes it only when the secret is non-empty rather
than always — `release-notarization.test.ts` covers both.

The `stapler` claim in the packaging section below was verified the same way
(`xcrun stapler staple --help`): *"Supported file formats are: UDIF disk images, code-signed
executable bundles, and signed 'flat' installer packages."* A bare Mach-O is none of those, which
is what settles the packaging question in favour of leaving distribution alone.

**Secrets to add in GitHub** (repository settings → Secrets and variables → Actions). Configure
*either* group; the API key is checked first:

| Secret | Meaning |
| --- | --- |
| `MACOS_NOTARIZATION_API_KEY` | The App Store Connect `.p8` private key, base64-encoded (`base64 -i AuthKey_XXXX.p8`) |
| `MACOS_NOTARIZATION_API_KEY_ID` | The key ID, ~10 alphanumeric characters |
| `MACOS_NOTARIZATION_API_ISSUER` | The issuer UUID. Set it for a **team** key; leave it unset for an **individual** key |
| `MACOS_NOTARIZATION_APPLE_ID` | Developer Apple ID (alternative to the three above) |
| `MACOS_NOTARIZATION_PASSWORD` | App-specific password for that Apple ID |
| `MACOS_NOTARIZATION_TEAM_ID` | Developer team ID |

With neither group configured the step reports `notarization=skipped`, which a prerelease publishes
through and a stable release does not — the same shape as `MACOS_SIGNING_*` today.

Follow the existing signing step's pattern exactly (`release.yml:56-82`): read credentials from
`secrets.*`, and if they are absent, fall through to an explicit non-notarized status rather than
failing the job — a prerelease must still be buildable by a contributor who has no Apple credentials
configured, the same way it is buildable with no signing certificate today.

### Gate

Add a `verifyNotarization` function to `scripts/verify-release.ts`, parallel to the existing
`verifySigning`/`verifyPerformance` (same file, same shape: required evidence via an env var,
throws with a specific message if missing, stable releases held to a stricter standard than
prereleases). A stable release must not publish with any status other than confirmed notarization —
mirror `verifySigning`'s exact rule (`if (!release.prerelease && signing !== 'signed') throw`) for
a new `WTM_RELEASE_NOTARIZATION` variable. Thread it through `release.yml` (`$GITHUB_ENV`, both the
per-architecture `verify` job's gate call and `publish`'s combined-gate call) exactly the way item
4's `WTM_RELEASE_PERFORMANCE` was threaded through — that recent change is the closest precedent
in this codebase for adding a new required-evidence gate end to end, both the script and the
workflow's structural test (`scripts/__tests__/release-workflow.test.ts`'s
`required` array).

### Packaging format — the one real open question

Item 5's own checklist names this directly: *"Gerekiyorsa artifact paket formatını notarization'a
göre düzenle"* (adjust the artifact package format for notarization, if needed). `notarytool submit`
accepts a zip, dmg, pkg, or a signed app bundle — WTM ships a bare Mach-O executable inside a plain
`.tar.gz`, not a bundle. `notarytool` can notarize a zip containing the raw executable, but
**stapling** a ticket (`xcrun stapler staple`) requires a bundle/dmg/pkg structure to hold it; a
stapled ticket cannot be attached to a bare executable file. Without stapling, Gatekeeper falls back
to an online ticket lookup against Apple's servers at first launch, which requires network access at
that moment.

Recommended default, to keep this increment's scope minimal: **do not change the distribution
format.** Zip the raw executable only for the `notarytool submit` call itself (a build-time
temporary artifact, not what ships), keep shipping the existing `.tar.gz` of the bare executable
for both the documented `curl` path and the browser-download path, and accept the online-lookup
requirement — document it plainly (a first run needs network access to clear Gatekeeper) rather
than re-architecting distribution into a `.pkg`. Revisit packaging only if `spctl --assess`
evidence from a real clean-machine run (see Acceptance criteria) shows the online lookup is
unreliable enough to matter. This keeps the change reversible and matches the checklist's own
"Gerekiyorsa" (only if needed) qualifier — try the smaller change first.

### `spctl --assess` verification

Add a step after notarization succeeds (in the `verify` job, after "Re-verify the signed
executable") that runs `spctl -a -t execute -v dist/sea/wtm` (or the zipped/notarized copy,
whichever `notarytool` actually accepted) and fails the step if it does not report accepted. This
is the CI-side proxy for "a clean machine accepts it" — it runs on the same `macos-15`/`macos-15-
intel` runners already building the release, which are clean machines with respect to this
specific binary.

### Removing the workaround

Once notarization is real and gated, in the **same change**:

- Delete the `<!-- gatekeeper-quarantine:start/end -->` regions from `README.md` and
  `CHANGELOG.md`.
- Delete `scripts/__tests__/gatekeeper-workaround.test.ts` — its own doc comment says exactly this:
  *"this file should be deleted in the same change that reaches it."*
- Update whatever release documentation (`docs/04-cli-reference.md` or similar, if it references
  the workaround) accordingly.

Do this last, only after the notarization step is real and gated — deleting the workaround first
would leave a real defect undocumented for however long the rest of this increment takes.

## Acceptance criteria (verbatim from `todo.md`)

Item 5:
- [ ] Stable artifact temiz macOS makinede Gatekeeper tarafından kabul ediliyor.
- [ ] Stable release notarization yoksa publish edilmiyor.

Item 36 (only one line left open; every other line already `[x]`):
- [ ] Notarization tamamlandığında bu geçici çözüm dokümandan kaldırılıyor.

## Out of scope

- Any change to the ad-hoc signing behavior for prereleases without a signing certificate — that
  stays exactly as it is.
- A `.pkg`/`.dmg` distribution format, unless the packaging decision above is revisited with real
  evidence that online ticket lookup is not good enough.
- Homebrew formula changes (`formula` job) — notarization affects the raw executable the formula
  already wraps, not the formula itself.

## What this increment cannot verify without the user

The actual `notarytool submit` call needs real Apple Developer credentials as GitHub secrets, which
only the user can add (an Apple ID/API key is not something an agent can obtain). The code and
workflow wiring in this spec can be written, tested locally with the "no credential configured"
fallback path, and even merged — but the true acceptance criteria ("Gatekeeper kabul ediyor" on a
real clean machine) can only be confirmed by a real tagged release run once those secrets exist.
Treat this the same way `verifySigning` already treats an absent signing certificate: buildable and
testable without the secret, gated on it for a stable release.

## Plan

See `docs/superpowers/plans/2026-09-07-macos-notarization-gatekeeper.md`.
