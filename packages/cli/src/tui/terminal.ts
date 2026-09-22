/**
 * Terminal lifecycle for `wtm tui`: enter the alternate screen buffer, hide the cursor and put
 * stdin into raw mode; restore all three exactly once, however the session ends.
 *
 * This is real process/terminal state, not a pure function — it cannot be meaningfully unit
 * tested without a real TTY, matching the split CLAUDE.md already draws between fixture tests and
 * native process/transport tests. It is exercised by hand, not by `bun test`. `render.ts` and
 * `view-model.ts` carry the parts of this feature that a test *can* mean something for.
 */

const enterAltScreen = '\x1b[?1049h';
const leaveAltScreen = '\x1b[?1049l';
const hideCursor = '\x1b[?25l';
const showCursor = '\x1b[?25h';

export interface TuiTerminalHandle {
  /** Restores raw mode, the cursor and the primary screen. Safe to call more than once. */
  restore(): void;
}

/**
 * Puts the terminal into the state `wtm tui` draws into, and returns a handle that always puts it
 * back — on a clean quit, on `SIGINT`/`SIGTERM`, or on an uncaught error in the render loop. A TUI
 * that leaves a user's terminal in raw mode or stuck on the alternate screen after a crash is a
 * real bug, so every exit path in `loop.ts` funnels through this one `restore`.
 */
export function enterTuiTerminal(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream): TuiTerminalHandle {
  stdout.write(enterAltScreen + hideCursor);
  const wasRaw = stdin.isTTY === true && stdin.isRaw === true;
  if (stdin.isTTY === true) stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  let restored = false;
  return {
    restore(): void {
      if (restored) return;
      restored = true;
      try {
        if (stdin.isTTY === true) stdin.setRawMode(wasRaw);
      } catch {
        // Best-effort: a stream already torn down (e.g. the process is exiting) has nothing left
        // to restore, and this must never be the thing that keeps a shutdown from completing.
      }
      stdin.pause();
      stdout.write(showCursor + leaveAltScreen);
    },
  };
}
