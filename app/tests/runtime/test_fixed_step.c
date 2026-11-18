// RUNTIME: shared by every game; your game goes in app/src/game/ and dom/game.js
//
// Tests for fixed_step.c: frame times in, whole steps out. No scene is ever
// described, so the game's hooks other than game_init never run: this holds
// whatever the game is.

#include <stdint.h>

#include "game/game.h"
#include "runtime/bridge.h"
#include "runtime/check.h"
#include "runtime/fixed_step.h"
#include "runtime/runtime.h"

static void test_fixed_step(void) {
    bridge_header *bridge = bridge_create((float)APP_STEP_HZ);
    runtime_state runtime;
    runtime_init(&runtime, bridge);
    fixed_step stepper = {0};
    constexpr uint32_t STEP_US = 1'000'000 / APP_STEP_HZ;

    // Start just before the frame clock wraps, to cover the wrap as well.
    uint32_t now = UINT32_MAX - 20'000u;
    CHECK(fixed_step_advance(&stepper, &runtime, now) == 0); // only starts the clock

    // 60 Hz frames: each pays for 120 / 60 = 2 steps, give or take one as the
    // remainder carries over, and never loses any on the way.
    uint32_t steps = 0;
    for (int frame = 0; frame < 60; ++frame) {
        now += 16'667u;
        uint32_t ran = fixed_step_advance(&stepper, &runtime, now);
        CHECK(ran >= 1 && ran <= 3);
        steps += ran;
    }
    CHECK(steps == (uint32_t)APP_STEP_HZ);
    CHECK(runtime.step == steps);

    // The newest step stands for a moment at most one step before the frame.
    uint32_t index = runtime.step & (bridge->snapshot_count - 1u);
    bridge_snapshot_header *snapshot =
        (bridge_snapshot_header *)(void *)((unsigned char *)bridge + bridge->snapshot_offset +
                                           index * bridge->snapshot_stride);
    CHECK(now - snapshot->time_us < STEP_US);

    // A long stall (a background tab) is capped at 100 ms worth of steps.
    now += 5'000'000u;
    uint32_t burst = fixed_step_advance(&stepper, &runtime, now);
    CHECK(burst >= (uint32_t)APP_STEP_HZ / 10 && burst <= (uint32_t)APP_STEP_HZ / 10 + 1);

    bridge_destroy(bridge);
}

int main(void) {
    test_fixed_step();
    return check_report();
}
