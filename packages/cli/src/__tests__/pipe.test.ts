import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { ignoreClosedOutput } from '../pipe';

describe('ignoreClosedOutput', () => {
  it('ends quietly when the reader closed the pipe', () => {
    const stream = new EventEmitter();
    const exits: number[] = [];
    ignoreClosedOutput([stream], (code) => exits.push(code));

    // `wtm status | head -2`: the answer was printed, and the reader stopped reading.
    expect(() => stream.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })))
      .not.toThrow();
    expect(exits).toEqual([0]);
  });

  it('still reports a real failure to write', () => {
    const stream = new EventEmitter();
    const exits: number[] = [];
    ignoreClosedOutput([stream], (code) => exits.push(code));

    expect(() => stream.emit('error', Object.assign(new Error('no space left'), { code: 'ENOSPC' })))
      .toThrow('no space left');
    expect(exits).toEqual([]);
  });
});
