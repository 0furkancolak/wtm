# TODO 17: untracked symbolic-link policy

The existing analysis excludes symlinks from untracked/ignored content. Add an optional
`[safety] untracked_symlinks = "ignore" | "review" | "block"` without changing that content
shape or weakening ignored/UTF-8/inspection/removal guards. Root owns config/protocol/CLI;
one subagent owns analysis and real Git safety scenarios; the other reviews integration.

## Contract

- `ignore` is the built-in default, not a per-layer Zod default. Global/workspace/nested/repo
  overrides and provenance retain their normal precedence. An absent leaf cannot reset a
  stricter parent. Invalid config exits 2 with `WTM_CONFIG_INVALID`; invalid direct-core
  context fails before Git with `GIT_REPOSITORY_DEGRADED`.
- Only Git-untracked links are affected. File, directory and dangling symlink targets are
  never followed. Ignored links and ordinary ignored files keep their existing behavior.
  Concurrent inspection preserves the ordered Git pathname list; non-ENOENT failures abort.
- `review` adds an advisory `GIT_UNTRACKED_SYMLINKS` warning and `REVIEW` when no blocker
  exists. `block` adds the same dedicated code as an error, causing removal exit 3.
  Context includes `policy`, `paths` and `count`. Content counts/paths remain unchanged.
- The dedicated blocker is never deferred to resource cleanup, including for a resource-owned
  link. Both removal analyses receive the same resolved configuration. Links appearing during
  cleanup and links replaced by ordinary files are reconsidered at the final gate.
- There is no new prompt, force flag or automatic unlink. Git's final unforced remove still
  vetoes an arbitrary untracked link under ignore/review. A CLI review warning is retained
  alongside that Git failure through the existing bounded warning re-analysis.

## Evidence

- Strict config and layering: RED 0/2, GREEN 2/0; all three values, invalid values/keys,
  built-in/global/workspace/nested/repo precedence and source/line attribution.
- New production CLI config behavior: RED 1/4 (invalid config already refused), then GREEN
  4/4. Actual Git/files/links verify analysis JSON, removal exit codes and surviving targets.
- Core feature cases: RED 0/6, then full 14/14 including default/ignore, review/block,
  dangling/directory links, mixed ignored/untracked contents, invalid direct context,
  inspection errors/disappearance, non-deferral, cleanup races and real Git veto.
- Combined config/core/CLI/explain/error-catalog group: 33/0.
- Review-mode warning loss on final Git veto was separately reproduced (RED 0/1) and fixed;
  the final CLI group passes 4/0. No error classification or Git refusal was relaxed.

Native Windows symlink creation/ACL behavior remains part of the platform gate, not proved
by this Linux filesystem run. No database migration, service, dependency or queue policy
change accompanies this feature. Existing code/docs parity tests cover the updated skill
and user commands; the new configuration and error code are included in their owning tests.


## Target-worktree policy review

Independent review found a P1 integration defect: explicit/all selectors originally loaded
policy from the invoking repository. A real-Git regression sets the caller to `ignore` and
a linked worktree's committed config to `block`; explicit/all analysis and removal must use
the target's policy. It failed before the correction. Analysis now resolves each selected
record's config, and removal resolves config after target selection and before runtime binding.
The symlink/allowed-ref CLI group passed **11/0** afterward. Final independent re-review found
no remaining findings. This also preserves target-specific allowed remote refs.
