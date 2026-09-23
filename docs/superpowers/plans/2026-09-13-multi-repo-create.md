# Multi-repository `wtm create` Implementation Plan

**Status: shipped.** This plan's checklist is complete; see `todo.md` (item 6) for the closing
note and `git log` for implementation history. The design rationale below is kept because other
files in the repo cite this path.

**Goal:** `wtm create <branch> --repos a,b,c` creates one worktree per named repository under one
persistent feature, journals every member, and `wtm create <branch> --resume` finishes a partial
creation without re-running an uncertain step or deleting anything.

**Architecture:** Migration 014 adds `features`, `feature_creations`, `feature_creation_members`
and rebuilds `repository_operation_leases` to allow `create`. Pure core functions resolve
`--repos` names, plan every member with pinned start OIDs, and classify a journalled member
against observed Git state. The CLI command module orchestrates: plan → ordered `create` leases →
second pre-flight → journal → apply → register → complete, and the same pipeline for `--resume`.

**Tech Stack:** Bun + TypeScript monorepo, better-sqlite3, Commander, `bun:test`, node
`--import tsx` scenario children.

**Spec:** `docs/superpowers/specs/2026-09-13-multi-repo-create-design.md`

## What shipped, in outline

1. Migration `014-feature-creations.sql`: the `create` lease operation, plus `features`,
   `feature_creations` and `feature_creation_members` tables.
2. `FeatureCreationStore` for journalling and reading back a creation in progress.
3. Ordered `create` leases across every named repository, taken before any Git write.
4. `resolveFeatureMembers` / `planFeatureCreation` / `resolveCommit` — resolving `--repos` names
   and planning every member with a pinned start commit.
5. `classifyMemberRecovery` — classifying a journalled member against real Git state for
   `--resume`, so a resume never re-runs an uncertain step or deletes anything.
6. `packages/cli/src/commands/create-feature.ts` — the `--repos` / `--resume` orchestration,
   wired into `wtm create` alongside the existing single-repository path (which is unchanged: no
   `--repos`, no `--resume`, no lease taken).
7. Recovery scenarios covering interrupted creations at each stage.
8. Documentation: `docs/04-cli-reference.md`, `docs/18-errors-json-contract.md`,
   `docs/03-configuration-spec.md`, `CHANGELOG.md`, and the `## Status` note on
   `docs/superpowers/specs/2026-09-07-create-worktree.md` pointing at the multi-repository design.

**Explicitly out of scope (per the spec):** `--abandon`, automatic completion at daemon startup,
a `wtm doctor` finding for a stalled creation, a feature-level lifecycle event, and different
branch names across member repositories. Single-repository `wtm create <branch>` takes no lease
and behaves exactly as it did before this work.

**Error codes used (none new):** `WTM_CONFIG_INVALID`, `WTM_NOT_INITIALIZED`,
`WTM_OPERATION_CONFLICT`, `WTM_WORKTREE_PATH_OCCUPIED`, `GIT_BRANCH_IN_USE`,
`GIT_REPOSITORY_DEGRADED`, `GIT_COMMAND_FAILED`; warning `WTM_DAEMON_UNAVAILABLE`.
