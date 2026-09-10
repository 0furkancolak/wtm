# Polyglot Example

Copy `wtm.toml` to a repository with JavaScript, Python, and Rust services in `services/web`, `services/api`, and `services/worker`. The Python task uses `uv`; install the listed toolchains before running the tasks.

```bash
cp examples/polyglot/wtm.toml ./wtm.toml
wtm resolve python-test
wtm run python-test
```

The three finite tasks are `js-test`, `python-test`, and `rust-test`, each with an explicit
service directory. `wtm run` waits and returns the task's exit status. To use the shared queue,
first opt the task in with `queue = true` and a finite `timeout` as described in the
[queue configuration](../../docs/03-configuration-spec.md#shared-heavy-job-memory-admission).
Read an enqueued job's final result before treating it as a passed test, and keep the files it
reads unchanged while it runs.

The file-copy example uses Bash syntax; copy the same TOML file with the native copy command
when using PowerShell. WTM's argv arrays avoid shell quoting differences, but Bun, uv/Python and
Cargo must still be installed for that operating system.
