// RUNTIME: shared by every game; your game goes in app/src/game/ and dom/game.js
//
// bridge.js — the page's view of the bridge block. Mirrors
// app/src/runtime/bridge.h, which is the authoritative description of the
// layout; read that first.
//
// This is the only file in dom/ that knows byte offsets, and every one of them
// is in LAYOUT below. `task test` (tools/check-bridge.mjs) imports this module
// in Node and compares LAYOUT with what the C compiler says, so a change to
// bridge.h that this file misses fails the test instead of reading garbage.
// That is also why nothing here touches `window` or `document`.
//
// Section positions come from the block's own section table, so LAYOUT only
// holds the fixed header fields and the field order inside each section.
//
// The block lives in the app worker's shared WebAssembly memory. The memory
// never grows, so the typed-array views made in the constructor stay valid
// until the app worker is replaced (then make a new Bridge).

// The parts of bridge.h this page uses, by their C names (the check compares
// names case-insensitively, so `KEY.W` is BRIDGE_KEY_W). Byte offsets unless
// the group says otherwise.
export const LAYOUT = {
  // BRIDGE_MAGIC ('AWSB' as little-endian bytes) and BRIDGE_VERSION.
  handshake: { magic: 0x42535741, version: 1 },
  // bridge_header
  header: {
    magic: 0,
    version: 4,
    total_size: 8,
    header_size: 12,
    latest_step: 28,
    stats_offset: 32,
    stats_size: 36,
    ring_offset: 64, // [4], indexed by ring_index
    ring_header_size: 80,
    record_size: 84,
    timing_offset: 88,
    timing_capacity: 92,
    timing_stride: 96,
  },
  // bridge_stats
  stats: {
    step_work_us: 0,
    frame_count: 4,
    frame_work_us: 8,
    frame_span_us: 12,
    gpu_frame_us: 16,
    gpu_frame_count: 20,
    app_late: 24,
    detail: 28, // written by this page: the `detail` bits below
  },
  // BRIDGE_DETAIL_*: the breakdowns the stats panel is showing.
  detail: { APP: 1, RENDERER: 2, GPU: 4 },
  // bridge_timing: one named running total of the timing table. `name_size`
  // is the size of its name field.
  timing: { kind: 0, total_ns: 4, count: 8, name: 12, name_size: 52 },
  // BRIDGE_TIMING_*: what an entry measures.
  timing_kind: {
    APP_PHASE: 1,
    RENDERER_PHASE: 2,
    RENDERER_PASS: 3,
    GPU_PASS: 4,
    RENDERER_OVERHEAD: 5,
  },
  // bridge_ring
  ring: { head: 0, tail: 4, capacity: 8, dropped: 12 },
  // bridge_record: `payload` is the u[14] / f[14] union.
  record: { type: 0, step: 4, payload: 8 },
  // sizeof(...), in bytes
  size: { header: 128, stats: 64, ring: 64, record: 64, timing: 64 },
  // BRIDGE_RING_*
  ring_index: { DOM_TO_APP: 0, APP_TO_DOM: 3 },
  // Record types (BRIDGE_EV_KEY, BRIDGE_APP_EVENT)
  record_type: { EV_KEY: 1, APP_EVENT: 48 },
  // BRIDGE_KEY_*: what the page reports. What a key does is up to the game.
  key: { W: 1, A: 2, S: 3, D: 4, UP: 5, DOWN: 6, LEFT: 7, RIGHT: 8, R: 9, SPACE: 10 },
};

export const KEY = LAYOUT.key;
export const RECORD = LAYOUT.record_type;
export const DETAIL = LAYOUT.detail;
export const TIMING = LAYOUT.timing_kind;

const HEADER = LAYOUT.header;
const STATS = LAYOUT.stats;
const RING = LAYOUT.ring;
const RING_INDEX = LAYOUT.ring_index;
const FIELD = LAYOUT.record;
const TIMING_FIELD = LAYOUT.timing;
const SIZE = LAYOUT.size;
// 32-bit words in a record's payload (14).
const PAYLOAD_WORDS = (SIZE.record - FIELD.payload) / 4;

// FNV-1a over the UTF-8 bytes of `name`: the same number bridge_hash() gives
// in C. Names (of scene nodes, for example) cross the bridge as these hashes.
export function bridgeHash(name) {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(name)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// One record taken out of a ring. drain() reuses a single instance, so copy
// out what you need inside the callback.
class RecordView {
  #u32;
  #f32;
  #word = 0;

  constructor(u32, f32) {
    this.#u32 = u32;
    this.#f32 = f32;
  }

  at(byteAddress) {
    this.#word = byteAddress >>> 2;
    return this;
  }

  get type() {
    return this.#u32[this.#word + FIELD.type / 4];
  }

  get step() {
    return this.#u32[this.#word + FIELD.step / 4];
  }

  // Payload word `i` as an unsigned integer (the C side's `u[i]`).
  u(i) {
    return this.#u32[this.#word + FIELD.payload / 4 + i];
  }

  // Payload word `i` as a float (the C side's `f[i]`).
  f(i) {
    return this.#f32[this.#word + FIELD.payload / 4 + i];
  }
}

export class Bridge {
  #u32;
  #f32;
  #base; // block start, in bytes
  #stats; // the stats section, in bytes
  #toApp; // the dom → app ring, in bytes
  #fromApp; // the app → dom ring, in bytes
  #ringHeaderSize;
  #recordSize;
  #record;
  #timings; // the timing table, in bytes
  #timingCapacity;
  #timingStride;
  #timingNames = []; // by entry; a name never changes once its kind is set

  // `memory`: the app's SharedArrayBuffer; `ptr`: byte address of the block.
  // Throws with a readable message if the block is not what this page expects.
  constructor(memory, ptr) {
    if (!(memory instanceof SharedArrayBuffer)) {
      throw new Error('bridge: expected the app memory as a SharedArrayBuffer');
    }
    // Everything in the block is a 32-bit word, read through word-indexed
    // views, so the address has to be a multiple of 4.
    if (!Number.isInteger(ptr) || ptr <= 0 || ptr % 4 !== 0 || ptr + SIZE.header > memory.byteLength) {
      throw new Error(`bridge: bad block address ${ptr}`);
    }
    this.#u32 = new Uint32Array(memory);
    this.#f32 = new Float32Array(memory);
    this.#base = ptr;

    const magic = this.#header(HEADER.magic);
    const version = this.#header(HEADER.version);
    if (magic !== LAYOUT.handshake.magic) {
      throw new Error(`bridge: no bridge block at ${ptr} (magic 0x${magic.toString(16)})`);
    }
    if (version !== LAYOUT.handshake.version) {
      throw new Error(
        `bridge: version mismatch: the app speaks v${version}, this page speaks ` +
          `v${LAYOUT.handshake.version}. Rebuild everything (task build).`,
      );
    }

    // The section table must describe a block this page can walk: every
    // section at least as big as this page knows it, inside the block, and
    // rings whose capacity is a power of two.
    const totalSize = this.#header(HEADER.total_size);
    const ringOffset = (which) => this.#header(HEADER.ring_offset + 4 * which);
    this.#stats = ptr + this.#header(HEADER.stats_offset);
    this.#toApp = ptr + ringOffset(RING_INDEX.DOM_TO_APP);
    this.#fromApp = ptr + ringOffset(RING_INDEX.APP_TO_DOM);
    this.#ringHeaderSize = this.#header(HEADER.ring_header_size);
    this.#recordSize = this.#header(HEADER.record_size);
    const inside = (start, size) => start >= ptr && start + size <= ptr + totalSize;
    const ringOk = (ring) => {
      if (!inside(ring, this.#ringHeaderSize)) return false;
      const capacity = this.#u32[(ring + RING.capacity) >>> 2];
      return (
        capacity > 0 &&
        (capacity & (capacity - 1)) === 0 &&
        inside(ring, this.#ringHeaderSize + capacity * this.#recordSize)
      );
    };
    this.#timings = ptr + this.#header(HEADER.timing_offset);
    this.#timingCapacity = this.#header(HEADER.timing_capacity);
    this.#timingStride = this.#header(HEADER.timing_stride);
    const consistent =
      ptr + totalSize <= memory.byteLength &&
      this.#timingStride >= SIZE.timing &&
      this.#timings % 4 === 0 &&
      this.#timingStride % 4 === 0 &&
      inside(this.#timings, this.#timingCapacity * this.#timingStride) &&
      this.#header(HEADER.header_size) >= SIZE.header &&
      this.#header(HEADER.stats_size) >= SIZE.stats &&
      this.#ringHeaderSize >= SIZE.ring &&
      this.#recordSize >= SIZE.record &&
      [this.#stats, this.#toApp, this.#fromApp].every((at) => at % 4 === 0) &&
      inside(this.#stats, SIZE.stats) &&
      ringOk(this.#toApp) &&
      ringOk(this.#fromApp);
    if (!consistent) {
      throw new Error('bridge: the block header is inconsistent');
    }
    this.#record = new RecordView(this.#u32, this.#f32);
  }

  #header(byteOffset) {
    return this.#u32[(this.#base + byteOffset) >>> 2];
  }

  // ── dom → app ring (this thread is the producer) ────────────────────────

  // A key went down or up. Returns false if the ring was full (the app is not
  // keeping up); the key is then lost, and counted in the ring's `dropped`.
  sendKey(key, down) {
    return this.#push(RECORD.EV_KEY, [key, down ? 1 : 0]);
  }

  // Writes one record with payload words `words` (u32s; unused ones are 0).
  #push(type, words) {
    const ring = this.#toApp;
    const headIndex = (ring + RING.head) >>> 2;
    const head = Atomics.load(this.#u32, headIndex); // only this thread writes it
    const tail = Atomics.load(this.#u32, (ring + RING.tail) >>> 2);
    const capacity = this.#u32[(ring + RING.capacity) >>> 2];
    if (((head - tail) >>> 0) >= capacity) {
      Atomics.add(this.#u32, (ring + RING.dropped) >>> 2, 1);
      return false;
    }

    const record = ring + this.#ringHeaderSize + (head & (capacity - 1)) * this.#recordSize;
    const word = record >>> 2;
    this.#u32[word + FIELD.type / 4] = type;
    this.#u32[word + FIELD.step / 4] = 0; // the page has no step number
    const payload = word + FIELD.payload / 4;
    this.#u32.fill(0, payload, payload + PAYLOAD_WORDS);
    this.#u32.set(words, payload);

    // Publish: the record's words are written before the new head is visible
    // (an atomic store is ordered after the plain writes above).
    Atomics.store(this.#u32, headIndex, (head + 1) >>> 0);
    return true;
  }

  // ── app → dom ring (this thread is the consumer) ────────────────────────

  // Calls `onRecord(view)` for every waiting record, oldest first. `view` has
  // .type, .step, .u(i) and .f(i), and is reused: copy out what you keep.
  drain(onRecord) {
    const ring = this.#fromApp;
    const tailIndex = (ring + RING.tail) >>> 2;
    let tail = Atomics.load(this.#u32, tailIndex); // only this thread writes it
    const head = Atomics.load(this.#u32, (ring + RING.head) >>> 2);
    const capacity = this.#u32[(ring + RING.capacity) >>> 2];
    while (tail !== head) {
      const record = ring + this.#ringHeaderSize + (tail & (capacity - 1)) * this.#recordSize;
      onRecord(this.#record.at(record));
      tail = (tail + 1) >>> 0;
      // Hand the slot back right away, so a slow callback never makes the
      // app see a full ring.
      Atomics.store(this.#u32, tailIndex, tail);
    }
  }

  // ── Stats ───────────────────────────────────────────────────────────────

  // The counters for the stats panel (bridge_stats), plus the newest
  // published step. All are running totals that wrap at 2^32: subtract two
  // readings with `(b - a) >>> 0`.
  readStats() {
    const load = (byteAddress) => Atomics.load(this.#u32, byteAddress >>> 2);
    const s = this.#stats;
    return {
      stepWorkUs: load(s + STATS.step_work_us),
      frameCount: load(s + STATS.frame_count),
      frameWorkUs: load(s + STATS.frame_work_us),
      frameSpanUs: load(s + STATS.frame_span_us),
      gpuFrameUs: load(s + STATS.gpu_frame_us),
      gpuFrameCount: load(s + STATS.gpu_frame_count),
      appLate: load(s + STATS.app_late),
      latestStep: load(this.#base + HEADER.latest_step),
    };
  }

  // Tells the app and the renderer which breakdowns the stats panel is
  // showing (DETAIL bits). They only measure the detail that is asked for.
  setDetail(bits) {
    Atomics.store(this.#u32, (this.#stats + STATS.detail) >>> 2, bits >>> 0);
  }

  // The timing table: every entry in use, as { slot, kind, name, totalNs,
  // count }. `kind` is a TIMING value; `totalNs` and `count` are running
  // totals that wrap at 2^32, and the mean per step or frame over a window is
  // the change in one divided by the change in the other.
  readTimings() {
    const entries = [];
    for (let slot = 0; slot < this.#timingCapacity; slot++) {
      const entry = this.#timings + slot * this.#timingStride;
      const kind = Atomics.load(this.#u32, (entry + TIMING_FIELD.kind) >>> 2);
      if (kind === 0) continue;
      entries.push({
        slot,
        kind,
        name: (this.#timingNames[slot] ??= this.#timingName(entry)),
        totalNs: Atomics.load(this.#u32, (entry + TIMING_FIELD.total_ns) >>> 2),
        count: Atomics.load(this.#u32, (entry + TIMING_FIELD.count) >>> 2),
      });
    }
    return entries;
  }

  // An entry's name: ASCII bytes up to the first zero. (Read byte by byte: a
  // TextDecoder does not accept a view of shared memory.)
  #timingName(entry) {
    const bytes = new Uint8Array(this.#u32.buffer, entry + TIMING_FIELD.name, TIMING_FIELD.name_size);
    let name = '';
    for (const byte of bytes) {
      if (byte === 0) break;
      name += String.fromCharCode(byte);
    }
    return name;
  }
}
