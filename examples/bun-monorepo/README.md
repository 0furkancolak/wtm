# Bun Monorepo Example

Copy `wtm.toml` to the root of a Bun monorepo containing `apps/web`. The example runs `bun run dev` in `apps/web` and `bun test` in the current worktree root. Install Bun and the project's dependencies first.

```bash
cp examples/bun-monorepo/wtm.toml ./wtm.toml
wtm resolve dev
wtm start dev
```

WTM resolves `{port.web}` to the allocated port; declaring a preferred port does not make the
application consume it automatically. If this application's dev script reads `PORT`, add:

```toml
[tasks.dev.env]
PORT = "{port.web}"
```

Otherwise pass the template through the application's actual port argument or environment
variable. `wtm resolve dev` shows the resulting argv and environment before the task starts.
Run the finite test task with `wtm run test`. All copy commands here use Bash syntax; in
PowerShell, copy the same configuration file with the shell's native file-copy command.
