// bridge.c — the app's side of the bridge block (see bridge.h for the layout).
//
// The only C file that computes an offset. Game code uses the functions
// declared at the bottom of bridge.h.

#include "bridge.h"

#include <stdlib.h>
#include <string.h>

#include <emscripten/atomic.h>

static uint32_t align_up(uint32_t n) {
    return (n + (BRIDGE_ALIGN - 1u)) & ~(BRIDGE_ALIGN - 1u);
}

// A section's address from its byte offset in the table.
static void *at(bridge_header *bridge, uint32_t offset) {
    return (unsigned char *)bridge + offset;
}

// Fills the section table of `h` and returns the total block size. This is
// where the capacities in bridge.h turn into the numbers the other threads
// read.
static uint32_t fill_layout(bridge_header *h) {
    uint32_t offset = align_up((uint32_t)sizeof(bridge_header));
    h->header_size = (uint32_t)sizeof(bridge_header);

    h->stats_offset = offset;
    h->stats_size = (uint32_t)sizeof(bridge_stats);
    offset += align_up(h->stats_size);

    h->snapshot_offset = offset;
    h->snapshot_count = BRIDGE_SNAPSHOT_COUNT;
    h->snapshot_header_size = (uint32_t)sizeof(bridge_snapshot_header);
    h->pose_capacity = BRIDGE_POSE_CAPACITY;
    h->pose_stride = (uint32_t)sizeof(bridge_pose);
    h->snapshot_stride = align_up(h->snapshot_header_size + h->pose_capacity * h->pose_stride);
    offset += h->snapshot_count * h->snapshot_stride;

    h->ring_header_size = (uint32_t)sizeof(bridge_ring);
    h->record_size = (uint32_t)sizeof(bridge_record);
    uint32_t ring_bytes = align_up(h->ring_header_size + BRIDGE_RING_CAPACITY * h->record_size);
    for (int i = 0; i < BRIDGE_RING_COUNT; ++i) {
        h->ring_offset[i] = offset;
        offset += ring_bytes;
    }

    h->timing_offset = offset;
    h->timing_capacity = BRIDGE_TIMING_CAPACITY;
    h->timing_stride = (uint32_t)sizeof(bridge_timing);
    offset += align_up(h->timing_capacity * h->timing_stride);

    h->total_size = offset;
    return offset;
}

// ── The block ──────────────────────────────────────────────────────────────

size_t bridge_block_size(void) {
    bridge_header scratch = {0};
    return fill_layout(&scratch);
}

bridge_header *bridge_init(void *memory, size_t size, float step_hz) {
    size_t needed = bridge_block_size();
    if (memory == nullptr || size < needed || (uintptr_t)memory % BRIDGE_ALIGN != 0) {
        return nullptr;
    }
    // Zero first: every counter and seqlock starts at 0, and no reader can
    // mistake leftover heap bytes for data.
    memset(memory, 0, needed);

    bridge_header *h = memory;
    fill_layout(h);
    h->step_hz = step_hz;
    for (int i = 0; i < BRIDGE_RING_COUNT; ++i) {
        bridge_get_ring(h, i)->capacity = BRIDGE_RING_CAPACITY;
    }

    // The handshake goes in last, so a block with a valid magic is always a
    // fully initialised one.
    h->version = BRIDGE_VERSION;
    atomic_thread_fence(memory_order_release);
    h->magic = BRIDGE_MAGIC;
    return h;
}

bridge_header *bridge_create(float step_hz) {
    size_t size = bridge_block_size(); // a multiple of BRIDGE_ALIGN, as aligned_alloc requires
    void *memory = aligned_alloc(BRIDGE_ALIGN, size);
    bridge_header *bridge = bridge_init(memory, size, step_hz);
    if (bridge == nullptr) {
        free(memory);
    }
    return bridge;
}

void bridge_destroy(bridge_header *bridge) {
    free(bridge);
}

bridge_stats *bridge_get_stats(bridge_header *bridge) {
    return at(bridge, bridge->stats_offset);
}

bridge_ring *bridge_get_ring(bridge_header *bridge, int which) {
    return at(bridge, bridge->ring_offset[which]);
}

// ── Timing table ───────────────────────────────────────────────────────────

uint32_t bridge_detail(bridge_header *bridge) {
    return atomic_load_explicit(&bridge_get_stats(bridge)->detail, memory_order_relaxed);
}

static bridge_timing *timing_slot(bridge_header *bridge, uint32_t slot) {
    return at(bridge, bridge->timing_offset + slot * bridge->timing_stride);
}

void bridge_timing_name(bridge_header *bridge, uint32_t slot, const char *name) {
    if (slot >= BRIDGE_TIMING_APP_SLOTS) {
        return;
    }
    bridge_timing *timing = timing_slot(bridge, slot);
    // The block starts zeroed, so a name shorter than the field stays
    // zero-padded; a longer one is cut (keeping the last byte zero).
    strncpy(timing->name, name, sizeof timing->name - 1);
    atomic_store_explicit(&timing->kind, (uint32_t)BRIDGE_TIMING_APP_PHASE, memory_order_release);
}

void bridge_timing_add(bridge_header *bridge, uint32_t slot, double milliseconds) {
    if (slot >= BRIDGE_TIMING_APP_SLOTS || !(milliseconds >= 0.0)) {
        return;
    }
    bridge_timing *timing = timing_slot(bridge, slot);
    atomic_fetch_add_explicit(&timing->total_ns, (uint32_t)(milliseconds * 1e6 + 0.5),
                              memory_order_relaxed);
    atomic_fetch_add_explicit(&timing->count, 1u, memory_order_relaxed);
}

// ── Event rings ────────────────────────────────────────────────────────────
//
// `head - tail` is the number of records waiting (unsigned subtraction keeps
// working when the counters wrap). The producer writes the record and THEN
// publishes it by storing the new head; the consumer reads the record and
// THEN frees the slot by storing the new tail. So neither side can ever see
// a slot the other is still using.

static bridge_record *ring_records(bridge_ring *ring) {
    return (bridge_record *)(void *)(ring + 1); // records follow the ring header
}

bool bridge_ring_push(bridge_ring *ring, const bridge_record *record) {
    uint32_t head = atomic_load_explicit(&ring->head, memory_order_relaxed); // ours
    uint32_t tail = atomic_load_explicit(&ring->tail, memory_order_acquire);
    if (head - tail >= ring->capacity) {
        atomic_fetch_add_explicit(&ring->dropped, 1u, memory_order_relaxed);
        return false;
    }
    ring_records(ring)[head & (ring->capacity - 1u)] = *record;
    atomic_store_explicit(&ring->head, head + 1u, memory_order_release);
    return true;
}

bool bridge_ring_pop(bridge_ring *ring, bridge_record *out) {
    uint32_t tail = atomic_load_explicit(&ring->tail, memory_order_relaxed); // ours
    uint32_t head = atomic_load_explicit(&ring->head, memory_order_acquire);
    if (head == tail) {
        return false;
    }
    *out = ring_records(ring)[tail & (ring->capacity - 1u)];
    atomic_store_explicit(&ring->tail, tail + 1u, memory_order_release);
    return true;
}

// ── Snapshots ──────────────────────────────────────────────────────────────
//
// The seqlock, from the writer's side: version → odd, write, version → even.
// The app is the only writer, so it never waits for anyone.

bridge_snapshot_header *bridge_snapshot_begin(bridge_header *bridge, uint32_t step) {
    uint32_t index = step & (bridge->snapshot_count - 1u);
    bridge_snapshot_header *snapshot =
        at(bridge, bridge->snapshot_offset + index * bridge->snapshot_stride);
    uint32_t version = atomic_load_explicit(&snapshot->version, memory_order_relaxed);
    atomic_store_explicit(&snapshot->version, version + 1u, memory_order_relaxed);
    // Keeps the "odd" store ahead of the data writes that follow, so a reader
    // that sees new data also sees that the snapshot was being written.
    atomic_thread_fence(memory_order_release);
    snapshot->step = step;
    return snapshot;
}

bridge_pose *bridge_snapshot_poses(bridge_snapshot_header *snapshot) {
    return (bridge_pose *)(void *)(snapshot + 1); // poses follow the header
}

void bridge_snapshot_publish(bridge_header *bridge, bridge_snapshot_header *snapshot) {
    uint32_t version = atomic_load_explicit(&snapshot->version, memory_order_relaxed);
    atomic_store_explicit(&snapshot->version, version + 1u, memory_order_release);
    atomic_store_explicit(&bridge->latest_step, snapshot->step, memory_order_release);
}

// ── Frame pacing ───────────────────────────────────────────────────────────

uint32_t bridge_frame_tick(bridge_header *bridge) {
    return atomic_load_explicit(&bridge->frame_tick, memory_order_acquire);
}

uint32_t bridge_frame_time(bridge_header *bridge) {
    // The renderer stores the time before it bumps the tick, so a reader that
    // has seen a tick sees that tick's time (or a newer one).
    return atomic_load_explicit(&bridge->frame_time_us, memory_order_acquire);
}

uint32_t bridge_wait_frame(bridge_header *bridge, uint32_t last) {
    for (;;) {
        uint32_t now = atomic_load_explicit(&bridge->frame_tick, memory_order_acquire);
        if (now != last) {
            return now;
        }
        // `memory.atomic.wait32`: sleeps only while the word still equals
        // `last`, so a tick that lands between the load above and this call
        // is not missed. Wake-ups can be spurious; the loop re-checks.
        emscripten_atomic_wait_u32((void *)&bridge->frame_tick, last,
                                   ATOMICS_WAIT_DURATION_INFINITE);
    }
}

void bridge_signal_frame(bridge_header *bridge, uint32_t time_us) {
    atomic_store_explicit(&bridge->frame_time_us, time_us, memory_order_release);
    atomic_fetch_add_explicit(&bridge->frame_tick, 1u, memory_order_release);
    emscripten_atomic_notify((void *)&bridge->frame_tick, EMSCRIPTEN_NOTIFY_ALL_WAITERS);
}
