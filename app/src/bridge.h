// bridge.h — THE contract between the three threads. Start reading here.
//
//   dom/       main thread, plain JS     reads + writes through typed-array views
//   renderer/  render worker, Rust       reads + writes through typed-array views
//   app/       app worker, C (this side) reads + writes through plain pointers
//
// The "bridge block" is one contiguous region inside the APP module's linear
// memory. That memory is a shared WebAssembly.Memory, so its SharedArrayBuffer
// can be handed to the other two threads. A wasm module can only dereference
// its own memory, which is why the block lives here: the app (where you
// iterate) touches it with zero copies, and the other threads go through
// views.
//
// This header is the single source of truth for the layout. It has two
// hand-written mirrors, `renderer/src/bridge.rs` and `dom/bridge.js`, and
// nothing else in the project knows an offset. `task test` compares both
// mirrors against this header (tools/check-bridge.mjs), so they cannot drift
// without a test failing.
//
// ── What is in the block ───────────────────────────────────────────────────
//
//   bridge_header    handshake (magic, version), the frame clock, and a
//                    SECTION TABLE: where everything below is and how big.
//                    Readers take positions from the table, so capacities can
//                    change here without rebuilding the renderer.
//   bridge_stats     counters for the page's stats panel.
//   snapshot ring    the app's published world state, one snapshot per fixed
//                    step: a pose (position + rotation) per slot. The newest
//                    BRIDGE_SNAPSHOT_COUNT steps are kept, and the renderer
//                    draws between two of them.              app → renderer
//   4 event rings    queues of small fixed-size records, for everything that
//                    happens at a moment rather than all the time:
//                      dom → app        key presses
//                      renderer → app   what the loaded scene contains
//                      app → renderer   "this slot drives that scene node",
//                                       "load the scene again"
//                      app → dom        app events, for the page to show
//
// ── How the threads stay out of each other's way (no locks anywhere) ───────
//
//   * Every field marked `_Atomic` is read and written with atomic operations
//     by all three sides (`Atomics.*` in JavaScript).
//   * A snapshot is guarded by a SEQLOCK, its `version` word: odd while the
//     app is writing it, even when stable. A reader copies the snapshot, then
//     checks that `version` is still the same even number; if not, it retries.
//     The writer never waits.
//   * Each ring has exactly ONE producer and ONE consumer. The producer owns
//     `head`, the consumer owns `tail`. Both only ever count up; the slot of
//     record n is `n & (capacity - 1)`.
//   * The only blocking wait anywhere is the app sleeping on `frame_tick`
//     between frames.
//
// ── Frame pacing ───────────────────────────────────────────────────────────
//
// One clock, the "frame clock", times everything: the timestamp the browser
// gives the renderer's requestAnimationFrame callback, in microseconds,
// wrapped to 32 bits. It wraps every 71 minutes, so only ever compare two
// readings by their signed difference, `(int32_t)(a - b)`.
//
//   1. At the START of each frame the renderer stores the frame's time in
//      `frame_time_us`, then bumps `frame_tick` and wakes the app.
//   2. The app runs as many fixed steps as the time since the previous frame
//      pays for (fixed_step.c) and publishes a snapshot per step. Each
//      snapshot carries the frame-clock time its step stands for.
//   3. The NEXT frame draws the moment "previous frame time − one step",
//      interpolating between the two snapshots around it. That moment moves
//      forward by exactly the time between frames, so motion is even however
//      the steps fell (2, 2, 2 … at 60 Hz; 1, 1, 1 … at 120 Hz). If the app
//      has not published that far yet, the renderer holds the newest snapshot
//      and counts the frame in `app_late`.
//
// ── Changing the layout ────────────────────────────────────────────────────
//
//   * Capacities (BRIDGE_SNAPSHOT_COUNT, BRIDGE_POSE_CAPACITY,
//     BRIDGE_RING_CAPACITY) and new record types the renderer does not need
//     to understand: just change them. No renderer rebuild.
//   * New fields: put them in `reserved` words, then add them to the mirrors
//     that use them.
//   * Anything that moves or changes the meaning of an existing field: also
//     bump BRIDGE_VERSION here and in both mirrors. On a mismatch the page
//     says so instead of drawing garbage.
//
// All values are little-endian (wasm). Offsets are in bytes.

#ifndef BRIDGE_H
#define BRIDGE_H

#include <stdatomic.h>
#include <stddef.h>
#include <stdint.h>

// ── Handshake ──────────────────────────────────────────────────────────────

// 'AWSB' as little-endian bytes. The first word of the block.
#define BRIDGE_MAGIC 0x42535741u
#define BRIDGE_VERSION 1u

// ── Capacities (free to change; readers use the section table) ─────────────

// Steps of history in the snapshot ring. The renderer reads two steps while
// the app writes its next burst, so this must exceed the largest burst by at
// least two (checked in fixed_step.c). Power of two.
#define BRIDGE_SNAPSHOT_COUNT 32u

// Pose slots per snapshot: the most things the app can move at once.
#define BRIDGE_POSE_CAPACITY 64u

// Records per event ring. Power of two.
#define BRIDGE_RING_CAPACITY 256u

// ── Header ─────────────────────────────────────────────────────────────────

// Which ring is which: an index into bridge_header.ring_offset.
enum {
    BRIDGE_RING_DOM_TO_APP = 0,
    BRIDGE_RING_RENDERER_TO_APP = 1,
    BRIDGE_RING_APP_TO_RENDERER = 2,
    BRIDGE_RING_APP_TO_DOM = 3,
    BRIDGE_RING_COUNT = 4,
};

typedef struct bridge_header {
    uint32_t magic;       //   0  BRIDGE_MAGIC, written last by bridge_init()
    uint32_t version;     //   4  BRIDGE_VERSION
    uint32_t total_size;  //   8  size of the whole block
    uint32_t header_size; //  12  sizeof(bridge_header)

    // The app's fixed simulation rate, steps per second.
    float step_hz; //  16

    // Bumped by the renderer at the start of every frame, after it has stored
    // that frame's time below. The app sleeps on this word between frames.
    _Atomic uint32_t frame_tick;    //  20
    _Atomic uint32_t frame_time_us; //  24  frame clock, see "Frame pacing"

    // The newest fully published step. Steps count from 1; 0 means the app
    // has not published anything yet.
    _Atomic uint32_t latest_step; //  28

    // Section table: where each part of the block starts (offsets from the
    // start of the block) and the sizes a reader needs to walk it.
    uint32_t stats_offset; //  32
    uint32_t stats_size;   //  36

    uint32_t snapshot_offset;      //  40  the first snapshot
    uint32_t snapshot_count;       //  44  snapshots in the ring (power of two)
    uint32_t snapshot_stride;      //  48  bytes from one snapshot to the next
    uint32_t snapshot_header_size; //  52  bytes before a snapshot's first pose
    uint32_t pose_capacity;        //  56  poses per snapshot
    uint32_t pose_stride;          //  60  bytes per pose

    uint32_t ring_offset[BRIDGE_RING_COUNT]; //  64  each points at a bridge_ring
    uint32_t ring_header_size;               //  80  bytes before a ring's first record
    uint32_t record_size;                    //  84  bytes per record

    uint32_t reserved[10]; //  88
} bridge_header;           // 128

// ── Stats (counters for the page's stats panel) ────────────────────────────
//
// Every field is a running total that wraps at 2^32. The page samples them
// once a second and shows the differences, so no thread ever resets one.

typedef struct bridge_stats {
    // Written by the app.
    _Atomic uint32_t step_work_us; //  0  CPU microseconds spent stepping

    // Written by the renderer.
    _Atomic uint32_t frame_count;     //  4  frames presented
    _Atomic uint32_t frame_work_us;   //  8  CPU microseconds spent preparing frames
    _Atomic uint32_t frame_span_us;   // 12  microseconds from each frame to the next
    _Atomic uint32_t gpu_frame_us;    // 16  GPU microseconds, over ...
    _Atomic uint32_t gpu_frame_count; // 20  ... this many measured frames
    _Atomic uint32_t app_late;        // 24  frames drawn before the app had caught up

    uint32_t reserved[9]; // 28
} bridge_stats;           // 64

// ── Snapshot ring (app → renderer) ─────────────────────────────────────────

// bridge_pose.flags
enum {
    // The slot is in use in this snapshot. The renderer ignores the rest.
    BRIDGE_POSE_ACTIVE = 1u << 0,
    // The object jumped this step: the renderer must not glide into this pose
    // from the previous one.
    BRIDGE_POSE_TELEPORT = 1u << 1,
};

// Where one object is, in world space. Scale is not here: a driven scene
// node keeps the scale it was authored with.
typedef struct bridge_pose {
    float position[3]; //  0
    float rotation[4]; // 12  quaternion x, y, z, w
    uint32_t flags;    // 28  BRIDGE_POSE_*
} bridge_pose;         // 32

typedef struct bridge_snapshot_header {
    _Atomic uint32_t version; //  0  seqlock: odd while being written
    uint32_t step;            //  4  which step this is (the ring reuses slots)
    uint32_t pose_count;      //  8  slots [0, pose_count) may be active
    uint32_t time_us;         // 12  the moment this step stands for, frame clock
} bridge_snapshot_header;     // 16

// A snapshot is a bridge_snapshot_header followed by pose_capacity poses.
// Step N lives in ring entry `N & (snapshot_count - 1)`.

// ── Event rings ────────────────────────────────────────────────────────────

typedef struct bridge_ring {
    _Atomic uint32_t head;    //  0  records ever written   (the producer's)
    _Atomic uint32_t tail;    //  4  records ever consumed  (the consumer's)
    uint32_t capacity;        //  8  power of two
    _Atomic uint32_t dropped; // 12  records discarded because the ring was full
    uint32_t reserved[12];    // 16
} bridge_ring;                // 64, followed by `capacity` records

// One event. `type` says which of the layouts below applies; `u` and `f` are
// two views of the same 14 payload words.
typedef struct bridge_record {
    uint32_t type; //  0  one of the BRIDGE_EV_ / SCENE_ / CMD_ / APP_ types below
    uint32_t step; //  4  the app step it was written in (0 from the other threads)
    union {
        uint32_t u[14];
        float f[14];
    }; //  8
} bridge_record; // 64

// Record types, grouped by the ring they travel on. Payload indices refer to
// `u[i]` / `f[i]`. A consumer skips types it does not know, which is what
// lets you add one without rebuilding everything.
enum {
    // ── dom → app ──────────────────────────────────────────────────────────
    // A key went down or up.     u[0] = BRIDGE_KEY_*    u[1] = 1 down, 0 up
    BRIDGE_EV_KEY = 1,

    // ── renderer → app ─────────────────────────────────────────────────────
    // The scene, described every time an app attaches (so a hot-swapped app
    // gets it too) and every time the scene is loaded again: a BEGIN, one
    // NODE per named scene node, then READY.
    //   u[0]       0: the scene is exactly as scene.toml has it, nobody has
    //                 driven it yet.
    //              1: a previous app instance has driven this scene (the
    //                 app was hot-swapped). Bound nodes are back where they
    //                 were authored, but anything else that app did to the
    //                 scene is still there.
    BRIDGE_SCENE_BEGIN = 16,
    // One scene node, as authored, in world space.
    //   u[0]       bridge_hash() of the node's name
    //   f[1..3]    translation
    //   f[4..7]    rotation quaternion x, y, z, w
    //   f[8..10]   scale
    BRIDGE_SCENE_NODE = 17,
    //   u[0]       how many NODE records were sent
    BRIDGE_SCENE_READY = 18,

    // ── app → renderer ─────────────────────────────────────────────────────
    // From now on, the scene node with this name follows this pose slot.
    //   u[0]       pose slot
    //   u[1]       bridge_hash() of the node's name
    BRIDGE_CMD_BIND = 32,
    // Throw the whole scene away and load it again from scene.toml. The GPU
    // device, the canvas, the page and its Settings (resolution,
    // anti-aliasing) stay; every object and every binding goes. The page
    // shows its loading screen meanwhile, and then the renderer describes the
    // fresh scene (BEGIN with u[0] = 0, NODE…, READY) exactly as after the
    // first load. No payload.
    BRIDGE_CMD_RELOAD_SCENE = 33,

    // ── app → dom ──────────────────────────────────────────────────────────
    // Something happened in the app that the page may want to show.
    //   u[0]       event id, defined by the app (APP_EVENT_* in app.h)
    //   f[1..3]    a world position, if the event has one
    BRIDGE_APP_EVENT = 48,
};

// Keys the page reports (dom/main.js maps `KeyboardEvent.code` to these).
// What a key DOES is decided in the app.
enum {
    BRIDGE_KEY_NONE = 0,
    BRIDGE_KEY_W = 1,
    BRIDGE_KEY_A = 2,
    BRIDGE_KEY_S = 3,
    BRIDGE_KEY_D = 4,
    BRIDGE_KEY_UP = 5,
    BRIDGE_KEY_DOWN = 6,
    BRIDGE_KEY_LEFT = 7,
    BRIDGE_KEY_RIGHT = 8,
    BRIDGE_KEY_R = 9,
    BRIDGE_KEY_SPACE = 10,
    BRIDGE_KEY_COUNT = 32, // room to add keys; the app keeps one bit per key
};

// Names cross the bridge as 32-bit hashes, never as strings: FNV-1a over the
// UTF-8 bytes. The Rust and JS mirrors compute exactly the same number.
static inline uint32_t bridge_hash(const char *name) {
    uint32_t h = 2166136261u;
    for (const unsigned char *p = (const unsigned char *)name; *p != 0; ++p) {
        h ^= *p;
        h *= 16777619u;
    }
    return h;
}

// ── Layout guards ──────────────────────────────────────────────────────────
// Sizes only: the per-field offsets are checked against the two mirrors by
// `task test` (app/tests/bridge_layout.c prints them, tools/check-bridge.mjs
// compares).

static_assert(sizeof(_Atomic uint32_t) == 4, "atomics must be plain 32-bit words");
static_assert(sizeof(bridge_header) == 128, "bridge_header size");
static_assert(sizeof(bridge_stats) == 64, "bridge_stats size");
static_assert(sizeof(bridge_pose) == 32, "bridge_pose size");
static_assert(sizeof(bridge_snapshot_header) == 16, "bridge_snapshot_header size");
static_assert(sizeof(bridge_ring) == 64, "bridge_ring size");
static_assert(sizeof(bridge_record) == 64, "bridge_record size");
static_assert((BRIDGE_SNAPSHOT_COUNT & (BRIDGE_SNAPSHOT_COUNT - 1u)) == 0, "power of two");
static_assert((BRIDGE_RING_CAPACITY & (BRIDGE_RING_CAPACITY - 1u)) == 0, "power of two");

// ═══ C API (bridge.c) ══════════════════════════════════════════════════════
// Everything above is the wire format, which the other two threads mirror.
// Everything below is how C code on the app side uses the block.

// Every section starts on a 64-byte boundary (a cache line), so one thread
// writing its section does not slow down a thread reading the next one.
#define BRIDGE_ALIGN 64u

// ── The block ──

// Bytes the block needs with the capacities above.
[[nodiscard]] size_t bridge_block_size(void);

// Lays the block out in `memory` (BRIDGE_ALIGN-aligned, at least
// bridge_block_size() bytes): zeroes it, fills the section table, and writes
// `magic` last. Returns nullptr if `memory` is unusable.
[[nodiscard]] bridge_header *bridge_init(void *memory, size_t size, float step_hz);

// bridge_init() on a fresh heap allocation. Free with bridge_destroy().
[[nodiscard]] bridge_header *bridge_create(float step_hz);
void bridge_destroy(bridge_header *bridge);

bridge_stats *bridge_get_stats(bridge_header *bridge);
bridge_ring *bridge_get_ring(bridge_header *bridge, int which); // BRIDGE_RING_*

// ── Event rings ──
//
//   bridge_record rec = {.type = BRIDGE_APP_EVENT, .step = step};
//   rec.u[0] = APP_EVENT_RESET;
//   bridge_ring_push(bridge_get_ring(bridge, BRIDGE_RING_APP_TO_DOM), &rec);
//
//   while (bridge_ring_pop(bridge_get_ring(bridge, BRIDGE_RING_DOM_TO_APP), &rec)) {
//       switch (rec.type) { ... default: break; } // skip types you don't know
//   }

// Producer side. Returns false (and counts it in `dropped`) when the ring is
// full: the record is discarded rather than waiting for the consumer.
bool bridge_ring_push(bridge_ring *ring, const bridge_record *record);

// Consumer side. Returns false when the ring is empty.
bool bridge_ring_pop(bridge_ring *ring, bridge_record *out);

// ── Snapshots (one per fixed step) ──
//
//   bridge_snapshot_header *snap = bridge_snapshot_begin(bridge, step);
//   snap->time_us = ...;
//   snap->pose_count = n;
//   bridge_pose *poses = bridge_snapshot_poses(snap);
//   ... fill poses[0 .. n-1] ...
//   bridge_snapshot_publish(bridge, snap);

// Claims the ring entry for `step` and marks it as being written.
bridge_snapshot_header *bridge_snapshot_begin(bridge_header *bridge, uint32_t step);

// The pose array that follows a snapshot header (pose_capacity entries).
bridge_pose *bridge_snapshot_poses(bridge_snapshot_header *snapshot);

// Marks the snapshot stable, THEN makes it the latest step.
void bridge_snapshot_publish(bridge_header *bridge, bridge_snapshot_header *snapshot);

// ── Frame pacing ──

uint32_t bridge_frame_tick(bridge_header *bridge);

// The frame time stored with the latest tick (frame clock, microseconds).
uint32_t bridge_frame_time(bridge_header *bridge);

// Sleeps until `frame_tick` differs from `last` (the renderer started a
// frame) and returns the new value. A real blocking wait, which browsers only
// allow on a worker. Returns at once if the tick has already moved on.
uint32_t bridge_wait_frame(bridge_header *bridge, uint32_t last);

// The renderer's half of that handshake: store the frame time, bump the tick,
// wake the app. The real renderer does this from Rust; the tests call it to
// stand in for one.
void bridge_signal_frame(bridge_header *bridge, uint32_t time_us);

#endif // BRIDGE_H
