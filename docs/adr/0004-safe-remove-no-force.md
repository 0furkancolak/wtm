# ADR 0004: No Loss-Bypassing Force Remove in V1

## Decision

`wtm remove` refuses removal if the worktree is dirty/untracked/unmerged or HEAD is not safely represented on an allowed remote-tracking ref. V1 exposes no WTM `--force` bypass.

## Context

Git itself can force removal, but WTM's value for autonomous AI workflows requires stronger guardrails around local-only work.

## Consequences

- agents cannot discard work through the normal WTM deletion path;
- users resolve commit/push/revert decisions explicitly;
- WTM prints remediation but does not auto-commit/push/reset/clean.
