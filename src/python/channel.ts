// Synchronous request channel from the Python worker to the main thread.
//
// Python's `adder` API is synchronous (`rng.values`), but cell state lives on
// the main thread. The worker posts a request and blocks on Atomics.wait; the
// main thread writes the JSON reply into shared memory and notifies. Replies
// larger than the buffer are sent in chunks.

export const CHUNK_BYTES = 4 * 1024 * 1024;

// ctrl slots
const STATE = 0; // 0 = waiting for reply, 1 = chunk ready
const LENGTH = 1; // bytes in this chunk
const MORE = 2; // 1 if more chunks follow

export interface ChannelBuffers {
  ctrl: SharedArrayBuffer;
  data: SharedArrayBuffer;
}

export function createChannel(): ChannelBuffers {
  return { ctrl: new SharedArrayBuffer(3 * 4), data: new SharedArrayBuffer(CHUNK_BYTES) };
}

/** Main-thread side: answer requests, chunking big replies. */
export class ChannelHost {
  private ctrl: Int32Array;
  private data: Uint8Array;
  private rest: Uint8Array | null = null;

  constructor(buffers: ChannelBuffers) {
    this.ctrl = new Int32Array(buffers.ctrl);
    this.data = new Uint8Array(buffers.data);
  }

  reply(json: string): void {
    this.rest = new TextEncoder().encode(json);
    this.next();
  }

  /** Send the next chunk of the current reply. */
  next(): void {
    const bytes = this.rest ?? new Uint8Array();
    const chunk = bytes.subarray(0, this.data.length);
    this.data.set(chunk);
    this.rest = bytes.length > chunk.length ? bytes.subarray(chunk.length) : null;
    Atomics.store(this.ctrl, LENGTH, chunk.length);
    Atomics.store(this.ctrl, MORE, this.rest ? 1 : 0);
    Atomics.store(this.ctrl, STATE, 1);
    Atomics.notify(this.ctrl, STATE);
  }
}

/** Worker side: blocking request. `send` posts the request (or a next-chunk ask). */
export class ChannelClient {
  private ctrl: Int32Array;
  private data: Uint8Array;

  constructor(buffers: ChannelBuffers) {
    this.ctrl = new Int32Array(buffers.ctrl);
    this.data = new Uint8Array(buffers.data);
  }

  request(send: (first: boolean) => void): string {
    const parts: Uint8Array[] = [];
    let first = true;
    for (;;) {
      Atomics.store(this.ctrl, STATE, 0);
      send(first);
      first = false;
      Atomics.wait(this.ctrl, STATE, 0);
      // TextDecoder rejects shared memory views, so copy out.
      parts.push(this.data.slice(0, Atomics.load(this.ctrl, LENGTH)));
      if (Atomics.load(this.ctrl, MORE) === 0) break;
    }
    const total = parts.reduce((n, p) => n + p.length, 0);
    const all = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      all.set(p, at);
      at += p.length;
    }
    return new TextDecoder().decode(all);
  }
}
