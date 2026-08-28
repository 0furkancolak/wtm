# Polyglot Example

Copy `wtm.toml` to a repository with JavaScript, Python, and Rust services in `services/web`, `services/api`, and `services/worker`. The Python task uses `uv`; install the listed toolchains before running the tasks.

```bash
cp examples/polyglot/wtm.toml ./wtm.toml
wtm resolve python-test
wtm start python-test
```

The three independent tasks are `js-test`, `python-test`, and `rust-test`, each with an explicit service directory.
