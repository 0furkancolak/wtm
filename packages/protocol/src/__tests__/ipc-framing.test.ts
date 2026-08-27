import { describe, expect, test } from 'bun:test';

const framing = await import('../ipc-framing').catch(() => null);

describe('IPC framing', () => {
  test('reassembles a frame split across header and body fragments', () => {
    expect(framing).not.toBeNull();
    if (framing === null) return;
    const decoder = new framing.FrameDecoder({ maxFrameBytes: 64 });
    const encoded = framing.encodeFrame(Buffer.from('{"ok":true}'), 64);

    expect(decoder.push(encoded.subarray(0, 2))).toEqual([]);
    expect(decoder.push(encoded.subarray(2, 6))).toEqual([]);
    expect(decoder.push(encoded.subarray(6)).map((frame) => frame.toString('utf8')))
      .toEqual(['{"ok":true}']);
  });

  test('emits every coalesced frame in order', () => {
    expect(framing).not.toBeNull();
    if (framing === null) return;
    const decoder = new framing.FrameDecoder({ maxFrameBytes: 64 });
    const input = Buffer.concat([
      framing.encodeFrame(Buffer.from('first'), 64),
      framing.encodeFrame(Buffer.from('second'), 64),
    ]);

    expect(decoder.push(input).map((frame) => frame.toString('utf8'))).toEqual(['first', 'second']);
  });

  test('rejects an oversized declared length as soon as the header arrives', () => {
    expect(framing).not.toBeNull();
    if (framing === null) return;
    const decoder = new framing.FrameDecoder({ maxFrameBytes: 8 });
    const header = Buffer.alloc(4);
    header.writeUInt32BE(9);

    expect(() => decoder.push(header)).toThrow(framing.FrameSizeError);
    expect(() => framing.encodeFrame(Buffer.alloc(9), 8)).toThrow(framing.FrameSizeError);
  });
});
