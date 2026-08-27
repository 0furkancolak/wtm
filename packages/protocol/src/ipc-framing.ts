export const defaultMaxIpcFrameBytes = 1024 * 1024;

export class FrameSizeError extends Error {
  readonly declaredBytes: number;
  readonly maxFrameBytes: number;

  constructor(declaredBytes: number, maxFrameBytes: number) {
    super(`IPC frame declares ${declaredBytes} bytes; maximum is ${maxFrameBytes}`);
    this.name = 'FrameSizeError';
    this.declaredBytes = declaredBytes;
    this.maxFrameBytes = maxFrameBytes;
  }
}

export function encodeFrame(
  payload: Uint8Array,
  maxFrameBytes = defaultMaxIpcFrameBytes,
): Buffer {
  assertFrameLimit(maxFrameBytes);
  if (payload.byteLength > maxFrameBytes) throw new FrameSizeError(payload.byteLength, maxFrameBytes);
  const frame = Buffer.allocUnsafe(4 + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(frame, 4);
  return frame;
}

export class FrameDecoder {
  readonly #maxFrameBytes: number;
  readonly #header = Buffer.alloc(4);
  #headerBytes = 0;
  #body: Buffer | null = null;
  #bodyBytes = 0;
  #failed = false;

  constructor(options: { maxFrameBytes?: number } = {}) {
    this.#maxFrameBytes = options.maxFrameBytes ?? defaultMaxIpcFrameBytes;
    assertFrameLimit(this.#maxFrameBytes);
  }

  get hasPartialFrame(): boolean {
    return this.#headerBytes > 0 || this.#body !== null;
  }

  push(chunk: Uint8Array): Buffer[] {
    if (this.#failed) throw new Error('IPC frame decoder cannot continue after a framing error');
    const source = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const frames: Buffer[] = [];
    let offset = 0;

    try {
      while (offset < source.byteLength) {
        if (this.#body === null) {
          const copied = source.copy(
            this.#header,
            this.#headerBytes,
            offset,
            Math.min(source.byteLength, offset + 4 - this.#headerBytes),
          );
          this.#headerBytes += copied;
          offset += copied;
          if (this.#headerBytes < 4) continue;

          const declaredBytes = this.#header.readUInt32BE(0);
          if (declaredBytes > this.#maxFrameBytes) {
            throw new FrameSizeError(declaredBytes, this.#maxFrameBytes);
          }
          this.#body = Buffer.allocUnsafe(declaredBytes);
          this.#bodyBytes = 0;
          if (declaredBytes === 0) {
            frames.push(Buffer.alloc(0));
            this.#resetFrame();
          }
          continue;
        }

        const copied = source.copy(
          this.#body,
          this.#bodyBytes,
          offset,
          Math.min(source.byteLength, offset + this.#body.byteLength - this.#bodyBytes),
        );
        this.#bodyBytes += copied;
        offset += copied;
        if (this.#bodyBytes === this.#body.byteLength) {
          frames.push(this.#body);
          this.#resetFrame();
        }
      }
      return frames;
    } catch (error) {
      this.#failed = true;
      throw error;
    }
  }

  #resetFrame(): void {
    this.#headerBytes = 0;
    this.#body = null;
    this.#bodyBytes = 0;
  }
}

function assertFrameLimit(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 0xffff_ffff) {
    throw new RangeError('Maximum IPC frame size must be an integer between 1 and 4294967295');
  }
}
