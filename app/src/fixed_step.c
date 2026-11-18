// fixed_step.c — see fixed_step.h.

#include "fixed_step.h"

#include <math.h>

constexpr int32_t MAX_GAP_US = 100'000;
constexpr double STEP_US = 1e6 / (double)APP_STEP_HZ;
// Enough steps to cover MAX_GAP_US, rounded up.
constexpr uint32_t MAX_STEPS = (uint32_t)(MAX_GAP_US / STEP_US) + 1u;

// The renderer reads two snapshots while the app writes its next burst into
// the same ring, so a burst must never wrap around onto them.
static_assert(MAX_STEPS + 2u <= BRIDGE_SNAPSHOT_COUNT,
              "the snapshot ring is too short for the largest burst of steps");

uint32_t fixed_step_advance(fixed_step *fs, app_state *app, uint32_t frame_time_us) {
    if (!fs->started) {
        fs->started = true;
        fs->last_us = frame_time_us;
        return 0;
    }

    // Signed difference, because the frame clock wraps.
    int32_t gap = (int32_t)(frame_time_us - fs->last_us);
    fs->last_us = frame_time_us;
    if (gap < 0) {
        gap = 0;
    }
    if (gap > MAX_GAP_US) {
        gap = MAX_GAP_US;
    }
    fs->accumulator_us += gap;

    const float dt = 1.0f / (float)APP_STEP_HZ;
    uint32_t steps = 0;
    while (fs->accumulator_us >= STEP_US && steps < MAX_STEPS) {
        fs->accumulator_us -= STEP_US;
        // The moment this step stands for. Worked out from the accumulator
        // every time rather than by adding STEP_US to the previous step's
        // time, which would drift.
        uint32_t time_us = frame_time_us - (uint32_t)llround(fs->accumulator_us);
        app_step(app, dt, time_us);
        steps += 1;
    }
    return steps;
}
