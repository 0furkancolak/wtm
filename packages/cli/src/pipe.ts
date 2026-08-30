/**
 * Ends quietly when whatever was reading the output goes away.
 *
 * `wtm status | head -2` closes the pipe the moment `head` has what it asked for, and Node
 * raises that on the stream as an unhandled `error` event: the command printed its answer and
 * then a seven-line EPIPE stack trace on top of it, and exited non-zero. A reader that has
 * stopped reading is not a failure of the command that was writing.
 */
export function ignoreClosedOutput(
  streams: readonly NodeJS.EventEmitter[] = [process.stdout, process.stderr],
  exit: (code: number) => void = (code) => { process.exit(code); },
): void {
  for (const stream of streams) {
    stream.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED') {
        exit(0);
        return;
      }
      // Anything else is a real failure of this process's own output, and still says so.
      throw error;
    });
  }
}
