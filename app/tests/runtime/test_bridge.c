// RUNTIME: shared by every game; your game goes in app/src/game/ and dom/game.js
//
// Tests for bridge.c: the block layout, the event rings and the snapshot seqlock.

#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "runtime/bridge.h"
#include "runtime/check.h"

static void test_layout(void) {
    bridge_header *b = bridge_create(120.0f);
    CHECK(b != nullptr);
    if (b == nullptr) {
        return;
    }

    CHECK((uintptr_t)b % BRIDGE_ALIGN == 0);
    CHECK(b->magic == BRIDGE_MAGIC);
    CHECK(b->version == BRIDGE_VERSION);
    CHECK(b->header_size == sizeof(bridge_header));
    CHECK(b->total_size == bridge_block_size());
    CHECK(b->step_hz == 120.0f);

    // Every section on its own cache line, in order, without overlaps.
    CHECK(b->stats_offset % BRIDGE_ALIGN == 0);
    CHECK(b->stats_offset >= b->header_size);
    CHECK(b->stats_size == sizeof(bridge_stats));

    CHECK(b->snapshot_offset % BRIDGE_ALIGN == 0);
    CHECK(b->snapshot_offset >= b->stats_offset + b->stats_size);
    CHECK(b->snapshot_count == BRIDGE_SNAPSHOT_COUNT);
    CHECK(b->snapshot_stride % BRIDGE_ALIGN == 0);
    CHECK(b->snapshot_stride >= b->snapshot_header_size + b->pose_capacity * b->pose_stride);
    CHECK(b->snapshot_header_size == sizeof(bridge_snapshot_header));
    CHECK(b->pose_capacity == BRIDGE_POSE_CAPACITY);
    CHECK(b->pose_stride == sizeof(bridge_pose));

    CHECK(b->ring_header_size == sizeof(bridge_ring));
    CHECK(b->record_size == sizeof(bridge_record));
    uint32_t end = b->snapshot_offset + b->snapshot_count * b->snapshot_stride;
    for (int i = 0; i < BRIDGE_RING_COUNT; ++i) {
        CHECK(b->ring_offset[i] % BRIDGE_ALIGN == 0);
        CHECK(b->ring_offset[i] >= end);
        end = b->ring_offset[i] + b->ring_header_size + BRIDGE_RING_CAPACITY * b->record_size;
        bridge_ring *ring = bridge_get_ring(b, i);
        CHECK(ring->capacity == BRIDGE_RING_CAPACITY);
        CHECK(atomic_load(&ring->head) == 0);
        CHECK(atomic_load(&ring->tail) == 0);
    }
    CHECK(b->timing_offset % BRIDGE_ALIGN == 0);
    CHECK(b->timing_offset >= end);
    CHECK(b->timing_capacity == BRIDGE_TIMING_CAPACITY);
    CHECK(b->timing_stride == sizeof(bridge_timing));
    end = b->timing_offset + b->timing_capacity * b->timing_stride;
    CHECK(end <= b->total_size);

    bridge_destroy(b);
}

static void test_timing_table(void) {
    bridge_header *b = bridge_create(60.0f);
    bridge_timing *table = (bridge_timing *)(void *)((unsigned char *)b + b->timing_offset);

    CHECK(atomic_load(&table[1].kind) == BRIDGE_TIMING_UNUSED);
    bridge_timing_name(b, 1, "simulate");
    CHECK(atomic_load(&table[1].kind) == BRIDGE_TIMING_APP_PHASE);
    CHECK(strcmp(table[1].name, "simulate") == 0);

    // Totals are in nanoseconds; the count is how many steps they cover.
    bridge_timing_add(b, 1, 0.0015); // 1.5 microseconds
    bridge_timing_add(b, 1, 0.0005);
    CHECK(atomic_load(&table[1].total_ns) == 2000u);
    CHECK(atomic_load(&table[1].count) == 2u);

    // The renderer's entries are not the app's to write.
    bridge_timing_name(b, BRIDGE_TIMING_APP_SLOTS, "not mine");
    bridge_timing_add(b, BRIDGE_TIMING_APP_SLOTS, 1.0);
    CHECK(atomic_load(&table[BRIDGE_TIMING_APP_SLOTS].kind) == BRIDGE_TIMING_UNUSED);
    CHECK(atomic_load(&table[BRIDGE_TIMING_APP_SLOTS].count) == 0u);

    // The page turns detail on and off through the stats section.
    CHECK(bridge_detail(b) == 0);
    atomic_store(&bridge_get_stats(b)->detail, BRIDGE_DETAIL_APP | BRIDGE_DETAIL_GPU);
    CHECK(bridge_detail(b) == (BRIDGE_DETAIL_APP | BRIDGE_DETAIL_GPU));

    bridge_destroy(b);
}

static void test_init_rejects_bad_memory(void) {
    size_t size = bridge_block_size();
    unsigned char *memory = aligned_alloc(BRIDGE_ALIGN, size + BRIDGE_ALIGN);
    CHECK(memory != nullptr);
    if (memory == nullptr) {
        return;
    }
    CHECK(bridge_init(nullptr, size, 60.0f) == nullptr);
    CHECK(bridge_init(memory, size - 1, 60.0f) == nullptr);    // too small
    CHECK(bridge_init(memory + 4, size, 60.0f) == nullptr);    // misaligned
    CHECK(bridge_init(memory, size, 60.0f) == (void *)memory); // just right
    free(memory);
}

static bridge_record make_record(uint32_t value) {
    bridge_record rec = {.type = BRIDGE_EV_KEY, .step = value};
    rec.u[0] = value;
    rec.u[13] = ~value; // the last payload word, to catch a short copy
    return rec;
}

static void test_ring_fifo_and_wraparound(void) {
    bridge_header *b = bridge_create(60.0f);
    bridge_ring *ring = bridge_get_ring(b, BRIDGE_RING_DOM_TO_APP);
    bridge_record out;

    CHECK(!bridge_ring_pop(ring, &out)); // empty

    // Go round the ring several times with a few records in flight, so the
    // slot index wraps while the ring is part-full.
    uint32_t next_in = 0;
    uint32_t next_out = 0;
    for (int round = 0; round < 4 * (int)BRIDGE_RING_CAPACITY; ++round) {
        for (int k = 0; k < 3; ++k) {
            bridge_record rec = make_record(next_in++);
            CHECK(bridge_ring_push(ring, &rec));
        }
        for (int k = 0; k < 3; ++k) {
            CHECK(bridge_ring_pop(ring, &out));
            CHECK(out.u[0] == next_out);
            CHECK(out.u[13] == ~next_out);
            next_out++;
        }
    }
    CHECK(!bridge_ring_pop(ring, &out));
    CHECK(atomic_load(&ring->dropped) == 0);

    bridge_destroy(b);
}

static void test_ring_full_drops(void) {
    bridge_header *b = bridge_create(60.0f);
    bridge_ring *ring = bridge_get_ring(b, BRIDGE_RING_APP_TO_DOM);
    bridge_record out;

    for (uint32_t i = 0; i < BRIDGE_RING_CAPACITY; ++i) {
        bridge_record rec = make_record(i);
        CHECK(bridge_ring_push(ring, &rec));
    }
    bridge_record extra = make_record(9999);
    CHECK(!bridge_ring_push(ring, &extra)); // full: dropped, not overwritten
    CHECK(atomic_load(&ring->dropped) == 1);

    CHECK(bridge_ring_pop(ring, &out));
    CHECK(out.u[0] == 0);                  // the oldest survived
    CHECK(bridge_ring_push(ring, &extra)); // room again

    bridge_destroy(b);
}

static void test_ring_counter_wrap(void) {
    // head and tail count up forever; they must survive passing 2^32.
    bridge_header *b = bridge_create(60.0f);
    bridge_ring *ring = bridge_get_ring(b, BRIDGE_RING_RENDERER_TO_APP);
    atomic_store(&ring->head, UINT32_MAX - 2u);
    atomic_store(&ring->tail, UINT32_MAX - 2u);

    for (uint32_t i = 0; i < 6; ++i) {
        bridge_record rec = make_record(i);
        CHECK(bridge_ring_push(ring, &rec));
    }
    CHECK(atomic_load(&ring->head) == 3u); // wrapped past zero
    bridge_record out;
    for (uint32_t i = 0; i < 6; ++i) {
        CHECK(bridge_ring_pop(ring, &out));
        CHECK(out.u[0] == i);
    }
    CHECK(!bridge_ring_pop(ring, &out));

    bridge_destroy(b);
}

static void test_snapshot_seqlock(void) {
    bridge_header *b = bridge_create(60.0f);

    bridge_snapshot_header *snap = bridge_snapshot_begin(b, 1);
    CHECK(atomic_load(&snap->version) % 2 == 1); // odd while writing
    CHECK(atomic_load(&b->latest_step) == 0);    // not published yet
    CHECK((unsigned char *)bridge_snapshot_poses(snap) ==
          (unsigned char *)snap + b->snapshot_header_size);
    bridge_snapshot_publish(b, snap);
    CHECK(atomic_load(&snap->version) == 2); // even again
    CHECK(snap->step == 1);
    CHECK(atomic_load(&b->latest_step) == 1);

    // Step 1 + count lands in the same ring entry and bumps the same seqlock.
    uint32_t again = 1 + BRIDGE_SNAPSHOT_COUNT;
    bridge_snapshot_header *reused = bridge_snapshot_begin(b, again);
    CHECK(reused == snap);
    bridge_snapshot_publish(b, reused);
    CHECK(atomic_load(&snap->version) == 4);
    CHECK(snap->step == again);
    CHECK(atomic_load(&b->latest_step) == again);

    // Consecutive steps use consecutive entries, one stride apart.
    bridge_snapshot_header *next = bridge_snapshot_begin(b, again + 1);
    CHECK((unsigned char *)next == (unsigned char *)snap + b->snapshot_stride);
    bridge_snapshot_publish(b, next);

    bridge_destroy(b);
}

static void test_frame_tick(void) {
    bridge_header *b = bridge_create(60.0f);
    uint32_t tick = bridge_frame_tick(b);
    bridge_signal_frame(b, 1000u);
    bridge_signal_frame(b, 0xFFFFFFF0u);
    CHECK(bridge_frame_tick(b) == tick + 2);
    CHECK(bridge_frame_time(b) == 0xFFFFFFF0u); // always the latest
    // The tick has already moved on, so this returns without sleeping.
    CHECK(bridge_wait_frame(b, tick) == tick + 2);
    bridge_destroy(b);
}

static void test_hash(void) {
    // Published FNV-1a 32-bit test vectors. bridge.js and bridge.rs must agree.
    CHECK(bridge_hash("") == 2166136261u);
    CHECK(bridge_hash("a") == 0xe40c292cu);
    CHECK(bridge_hash("foobar") == 0xbf9cf968u);
    CHECK(bridge_hash("Ball") != bridge_hash("ball"));
}

int main(void) {
    test_layout();
    test_init_rejects_bad_memory();
    test_ring_fifo_and_wraparound();
    test_ring_full_drops();
    test_ring_counter_wrap();
    test_snapshot_seqlock();
    test_timing_table();
    test_frame_tick();
    test_hash();
    return check_report();
}
