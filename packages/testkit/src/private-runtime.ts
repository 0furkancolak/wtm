import { runInternalMode } from '../../cli/src/internal';
import { ignoreClosedOutput } from '../../cli/src/pipe';

// Bundle only the real private dispatcher: anchors, adapter descriptors, and endpoint probes
// do not need the public CLI, its SQLite driver, or a runtime TypeScript compiler.
ignoreClosedOutput();
runInternalMode(process.argv.slice(2)).then(
  (exitCode) => { process.exitCode = exitCode ?? 2; },
  () => { process.exitCode = 1; },
);
