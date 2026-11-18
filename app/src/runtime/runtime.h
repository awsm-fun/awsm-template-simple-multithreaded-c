// RUNTIME: shared by every game; your game goes in app/src/game/ and dom/game.js
//
// runtime.h — runs your game, one fixed step at a time, and is the only code
// that talks to the other two threads for it.
//
// Nothing here knows about the browser, or about what your game is. The runtime
// talks to the outside world only through the bridge block, so the same code
// runs in the page's worker (web_main.c) and, with no browser at all, in the
// tests (app/tests/).
//
// Every fixed step (runtime_step) does four things, in order:
//
//   1. read what the renderer says about the scene   (renderer → app ring)
//   2. read what the user did                         (dom → app ring)
//   3. let the game move the world                    (game_update)
//   4. publish the result                             (a snapshot of poses)
//
// ── The contract with your game (app/src/game/) ────────────────────────────
//
// Your game provides GAME_OBJECTS[] and the five game_* hooks declared below;
// game.h provides GAME_OBJ_COUNT, game_state, APP_STEP_HZ and
// GAME_RELOAD_SCENE_ON_HOT_SWAP. The game calls back only the runtime_*
// functions in "The API your game calls".
//
// Poses: the runtime keeps one runtime_object per GAME_OBJ_* id, filled in from
// the scene by name. The game moves an object by setting its `position` and
// `rotation` (runtime_get_object); after game_update the runtime publishes every
// driven object that the scene has. So the game never sees a ring or a
// snapshot, and the runtime never needs to know what an object means.

#ifndef RUNTIME_H
#define RUNTIME_H

#include <stdint.h>

#include "game/game.h"
#include "runtime/bridge.h"
#include "runtime/math3d.h"

static_assert((unsigned)GAME_OBJ_COUNT <= BRIDGE_POSE_CAPACITY, "more objects than pose slots");

// ── Objects ────────────────────────────────────────────────────────────────

// One row of GAME_OBJECTS: how the runtime finds an object in the scene.
typedef struct runtime_object_def {
    // The scene node's name in media/bundle/scene.toml. (Names cross the
    // bridge as hashes; see bridge_hash() in bridge.h.)
    const char *name;
    // Moved by the game: bound to a pose slot (the slot number is the
    // object's id) and published every step. The others are only looked at:
    // where the scene put them and how big.
    bool driven;
} runtime_object_def;

// An object's pose, as the runtime knows it. The game reads it and, for a
// driven object, writes `position`, `rotation` and `teleported`.
typedef struct runtime_object {
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
} runtime_object;

// ── State ──────────────────────────────────────────────────────────────────

typedef struct runtime_state {
    bridge_header *bridge;
    uint32_t step; // the last step run; the first is 1

    // Set once the renderer has described the scene. The game is not run
    // before.
    bool scene_ready;
    // runtime_reload_scene() was called: what the renderer still says about
    // the old scene is ignored until the description of the fresh one begins.
    bool reload_pending;
    runtime_object objects[GAME_OBJ_COUNT];

    // Keys currently held: bit k is BRIDGE_KEY_k, kept up to date from the
    // page's key events.
    uint32_t keys_down;
    // Keys that went down since the last step, even if they are up again
    // already: a tap shorter than a step still counts as held for one step.
    uint32_t keys_tapped;

    // Time the phases of each step for the page's stats panel. Set by the
    // run loop while the panel has the app's breakdown open, and only then:
    // reading the clock a few times per step is not free.
    bool profile;

    // Your game's own state. The runtime only hands it to the hooks.
    game_state game;
} runtime_state;

// ── Running the runtime (web_main.c, fixed_step.c and the tests) ────────────

// Sets `runtime` up to talk through `bridge`, which must outlive it, and
// calls game_init().
void runtime_init(runtime_state *runtime, bridge_header *bridge);

// Runs one fixed step of `dt` seconds and publishes the result as a
// snapshot. `time_us` is the moment the step stands for on the frame clock
// (fixed_step.c works it out).
void runtime_step(runtime_state *runtime, float dt, uint32_t time_us);

// ═══ Your game provides (app/src/game/game.c) ══════════════════════════════

// Which scene node each GAME_OBJ_* id is, indexed by id.
extern const runtime_object_def GAME_OBJECTS[GAME_OBJ_COUNT];

// Once, when the app starts (and so after every hot swap): set up `game`.
// No scene yet.
void game_init(runtime_state *runtime, game_state *game);

// A scene description is starting (after the first load, after every reload,
// and when a hot-swapped app attaches): the world begins again from nothing.
// Reset your game state here (score, level, …). Objects are not found yet.
void game_scene_begin(runtime_state *runtime, game_state *game);

// The scene is described: every object it has is `found`, at its authored
// pose, and the driven ones are bound. The game starts running.
void game_scene_ready(runtime_state *runtime, game_state *game);

// Key `key` (BRIDGE_KEY_*) went down or up. Only called while the scene is
// ready. For one-off actions; keys that act for as long as they are held are
// polled with runtime_key_held() in game_update().
void game_key(runtime_state *runtime, game_state *game, uint32_t key, bool down);

// One fixed step of `dt` seconds, while the scene is ready: your game loop.
void game_update(runtime_state *runtime, game_state *game, float dt);

// ═══ The API your game calls ═══════════════════════════════════════════════

// Object `id` (GAME_OBJ_*). Set `position` and `rotation` to move a driven
// one, and `teleported = true` when it jumps rather than moves.
runtime_object *runtime_get_object(runtime_state *runtime, uint32_t id);

// Whether key `key` (BRIDGE_KEY_*) counts as held in the current step.
bool runtime_key_held(const runtime_state *runtime, uint32_t key);

// Tells the page that something happened: `event` is one of your
// GAME_EVENT_* ids, `where` a world position (dom/game.js gets both).
void runtime_send_event(runtime_state *runtime, uint32_t event, vec3 where);

// Asks the renderer to destroy everything in the scene and load it again from
// scene.toml, without touching the GPU device or reloading the page
// (BRIDGE_CMD_RELOAD_SCENE). The game is not run until the renderer has
// described the fresh scene; it then starts over, from game_scene_begin(),
// exactly as after the first load. Call it from anywhere in the game: a
// "restart level" key (R in the demo), a game-over screen, the next level.
void runtime_reload_scene(runtime_state *runtime);

// The step being run, counting from 1. Steps are 1 / APP_STEP_HZ apart.
uint32_t runtime_current_step(const runtime_state *runtime);

#endif // RUNTIME_H
