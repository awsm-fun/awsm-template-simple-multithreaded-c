// RUNTIME: shared by every game; your game goes in app/src/game/ and dom/game.js
//
// web_main.c — the browser entry point.
//
// app/web/worker.js loads this module in a dedicated worker and calls:
//
//   app_start()  once: creates the bridge block and returns its address,
//                which the worker hands to the page together with the memory.
//   app_run()    then: the frame-paced loop. It never returns.
//
// Because app_run() never returns, this worker never gets back to its
// JavaScript event loop and cannot receive postMessage. That is intended:
// everything coming in arrives through the bridge block instead.
//
// printf still works while the loop runs: Emscripten turns each finished line
// into a console.log() call, which appears in the browser console prefixed
// with [app]. Output is line-buffered, so end messages with '\n'.

#include <emscripten/em_macros.h>
#include <emscripten/emscripten.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>

#include "game/game.h"
#include "runtime/bridge.h"
#include "runtime/fixed_step.h"
#include "runtime/runtime.h"

// EMSCRIPTEN_KEEPALIVE exports a function to JavaScript as `module._name`.
// (The prototypes keep -Wmissing-prototypes quiet; JS is the only caller.)
EMSCRIPTEN_KEEPALIVE uintptr_t app_start(void);
EMSCRIPTEN_KEEPALIVE void app_run(void);

static bridge_header *bridge;
static runtime_state runtime;
static fixed_step stepper;

uintptr_t app_start(void) {
    if (bridge == nullptr) {
        bridge = bridge_create((float)APP_STEP_HZ);
        if (bridge == nullptr) {
            fprintf(stderr, "app: could not allocate the bridge block\n");
            return 0;
        }
        runtime_init(&runtime, bridge);
        printf("app: bridge block ready (%u bytes), stepping at %d Hz\n", bridge->total_size,
               APP_STEP_HZ);
    }
    return (uintptr_t)bridge;
}

void app_run(void) {
    if (bridge == nullptr) {
        fprintf(stderr, "app: app_run() called before app_start()\n");
        return;
    }
    bridge_stats *stats = bridge_get_stats(bridge);

    // Sleep until the renderer starts a frame, run the steps that frame's
    // time pays for, sleep again. Stepping by the renderer's frame times,
    // rather than by when this thread happens to wake up, is what keeps the
    // number of steps per frame steady (bridge.h, "Frame pacing").
    uint32_t tick = bridge_frame_tick(bridge);
    for (;;) {
        tick = bridge_wait_frame(bridge, tick);

        // Phase timing only while the stats panel shows the app's breakdown.
        runtime.profile = (bridge_detail(bridge) & BRIDGE_DETAIL_APP) != 0;
        double start_ms = emscripten_get_now();
        uint32_t steps = fixed_step_advance(&stepper, &runtime, bridge_frame_time(bridge));
        if (steps > 0) {
            // For the stats panel: the app's CPU time, as a running total.
            double work_us = (emscripten_get_now() - start_ms) * 1000.0;
            atomic_fetch_add_explicit(&stats->step_work_us, (uint32_t)(work_us + 0.5),
                                      memory_order_relaxed);
        }
    }
}
