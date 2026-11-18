// RUNTIME: shared by every game; your game goes in app/src/game/ and dom/game.js
//
// fixed_step.h — turns "a frame has started" into a whole number of app steps.
//
// The simulation always advances in steps of exactly 1 / APP_STEP_HZ seconds,
// however far apart frames are. Real time goes into an accumulator and comes
// out as as many whole steps as it pays for; the remainder carries over to
// the next frame. A step is never stretched or split, so the app behaves the
// same on a 60 Hz and a 144 Hz display. (This is Glenn Fiedler's "Fix Your
// Timestep": https://gafferongames.com/post/fix_your_timestep/)

#ifndef FIXED_STEP_H
#define FIXED_STEP_H

#include <stdint.h>

#include "runtime/runtime.h"

typedef struct fixed_step {
    bool started;
    uint32_t last_us;      // the previous frame's time
    double accumulator_us; // real time not yet turned into steps
} fixed_step;

// Call once per frame with the frame's time on the frame clock (bridge.h,
// "Frame pacing": microseconds, wrapping). Runs runtime_step() as many times as
// the time since the previous call pays for, and returns how many it ran.
// The first call only starts the clock.
//
// Each step is told the moment it stands for: the frame time minus whatever
// is still left in the accumulator after it. The renderer uses those times
// to interpolate to an exact moment.
//
// Two limits keep one slow moment from snowballing (the "spiral of death",
// where catching up takes so long that there is even more to catch up next
// time): a gap longer than 100 ms (a background tab, a debugger pause) counts
// as 100 ms, and time beyond that is dropped. The world pauses rather than
// fast-forwarding.
uint32_t fixed_step_advance(fixed_step *fs, runtime_state *runtime, uint32_t frame_time_us);

#endif // FIXED_STEP_H
