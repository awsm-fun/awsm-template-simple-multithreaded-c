// app.h — the application: all state and logic, independent of the platform.
//
// Nothing here knows about the browser. The app talks to the outside world
// only through the bridge block, so the same code runs in the page's worker
// (web_main.c) and, with no browser at all, in the tests (tests/test_app.c).
//
// The demo: a ball on the ground that W/A/S/D or the arrow keys roll around.
// Space puts it back; R loads the whole scene again. No physics; the app just
// decides where the ball is.

#ifndef APP_H
#define APP_H

#include "bridge.h"
#include "math3d.h"

// Fixed simulation rate, steps per second. The renderer reads it from the
// bridge header. Raising it means more, smaller steps, not a faster game, as
// long as every speed in app.c is per second and multiplied by `dt`.
enum { APP_STEP_HZ = 120 };

// What happens to the scene when you save a C file and `task dev` swaps a new
// build of the app into the running page:
//
//   1  the new app asks the renderer to load the scene again
//      (app_reload_scene), so every save starts from scene.toml, whatever the
//      previous build did to the world. Costs a scene load per save.
//   0  the new app takes over the scene as the renderer has it. Instant, and
//      fine while all the app does is move bound nodes (the renderer puts
//      those back where they were authored). Anything else the previous
//      build changed in the scene would still be there.
#define APP_RELOAD_SCENE_ON_HOT_SWAP 1

// ── Scene objects ──────────────────────────────────────────────────────────
//
// The scene nodes the app uses. Each id is matched to a node of
// media/bundle/scene.toml BY NAME (the table at the top of app.c), and
// doubles as the object's pose slot. To use another node, add an id here and
// a row there.
typedef enum app_object_id {
    APP_OBJ_BALL,
    APP_OBJ_GROUND,
    APP_OBJ_COUNT,
} app_object_id;
static_assert((unsigned)APP_OBJ_COUNT <= BRIDGE_POSE_CAPACITY, "more objects than pose slots");

typedef struct app_object {
    bool found; // the loaded scene has a node with this object's name
    // Jumped this step (rather than moved): tells the renderer not to glide
    // the object from its old place to the new one. Cleared once published.
    bool teleported;
    // Where it is now, in world space. Starts out as the scene has it.
    vec3 position;
    quat rotation;
    // As authored in the scene; these never change.
    vec3 start_position;
    quat start_rotation;
    vec3 scale;
} app_object;

// ── Events for the page ────────────────────────────────────────────────────
//
// Ids carried by BRIDGE_APP_EVENT records (u[0]); f[1..3] is where it
// happened. dom/main.js has the matching table and decides how to show them.
enum {
    APP_EVENT_RESET = 1, // the ball was put back where the scene has it
    APP_EVENT_EDGE = 2,  // the ball reached the edge of the ground
};

// ── State ──────────────────────────────────────────────────────────────────

typedef struct app_state {
    bridge_header *bridge;
    uint32_t step; // the last step published; the first is 1

    // Set once the renderer has described the scene. Nothing moves before.
    bool scene_ready;
    // app_reload_scene() was called: what the renderer still says about the
    // old scene is ignored until the description of the fresh one begins.
    bool reload_pending;
    app_object objects[APP_OBJ_COUNT];

    // Keys currently held: bit k is BRIDGE_KEY_k, kept up to date from the
    // page's key events.
    uint32_t keys_down;
    // Keys that went down since the last step, even if they are up again
    // already: a tap shorter than a step still counts as held for one step.
    uint32_t keys_tapped;
    // The ball is against the edge of the ground, so that APP_EVENT_EDGE is
    // sent when it arrives there, not on every step it stays.
    bool at_edge;

    // Time the phases of each step for the page's stats panel. Set by the
    // run loop while the panel has the app's breakdown open, and only then:
    // reading the clock a few times per step is not free.
    bool profile;
} app_state;

// Sets `app` up to talk through `bridge`, which must outlive it.
void app_init(app_state *app, bridge_header *bridge);

// Advances the world by one fixed step of `dt` seconds and publishes the
// result as a snapshot. `time_us` is the moment the step stands for on the
// frame clock (fixed_step.c works it out).
void app_step(app_state *app, float dt, uint32_t time_us);

// Whether key `key` (BRIDGE_KEY_*) counts as held in the current step.
bool app_key_held(const app_state *app, uint32_t key);

// Asks the renderer to destroy everything in the scene and load it again from
// scene.toml, without touching the GPU device or reloading the page
// (BRIDGE_CMD_RELOAD_SCENE). Nothing is simulated until the renderer has
// described the fresh scene; the app's world then starts over, exactly as
// after the first load. Call it from anywhere in the app: a "restart level"
// key (R in the demo), a game-over screen, loading the next level.
void app_reload_scene(app_state *app);

#endif // APP_H
