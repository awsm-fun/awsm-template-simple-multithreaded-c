// YOUR GAME: start here
//
// game.h — what the runtime needs to know about your game at compile time: its
// objects, its events, its state, its step rate. game.c is the logic.
//
// The demo: a ball on the ground that W/A/S/D or the arrow keys roll around.
// Space puts it back; R loads the whole scene again. No physics; the game just
// decides where the ball is.
//
// ── The contract with the runtime (app/src/runtime/runtime.h) ──────────────
//
// game.c defines these, and the runtime calls them; nothing else does:
//
//   GAME_OBJECTS[]        which scene node each GAME_OBJ_* id is, by name
//   game_init             once, when the app starts
//   game_scene_begin      a scene description begins: reset your state
//   game_scene_ready      the scene is described and your objects are bound
//   game_key              a key went down or up (only while the scene is ready)
//   game_update           once per fixed step, while the scene is ready
//
// and calls only these runtime_* functions back (never the bridge itself):
//
//   runtime_get_object    an object's pose: read it, set position/rotation
//   runtime_key_held      is a key down this step
//   runtime_send_event    tell the page something happened (GAME_EVENT_*)
//   runtime_reload_scene  load the scene again from scene.toml
//   runtime_current_step  the step being run, counting from 1
//
// The runtime publishes every driven object's pose after game_update returns.

#ifndef GAME_H
#define GAME_H

// Fixed simulation rate, steps per second. The renderer reads it from the
// bridge header. Raising it means more, smaller steps, not a faster game, as
// long as every speed in game.c is per second and multiplied by `dt`.
enum { APP_STEP_HZ = 120 };

// What happens to the scene when you save a C file and `task dev` swaps a new
// build of the app into the running page:
//
//   1  the new app asks the renderer to load the scene again
//      (runtime_reload_scene), so every save starts from scene.toml, whatever
//      the previous build did to the world. Costs a scene load per save.
//   0  the new app takes over the scene as the renderer has it. Instant, and
//      fine while all the game does is move bound nodes (the renderer puts
//      those back where they were authored). Anything else the previous
//      build changed in the scene would still be there.
#define GAME_RELOAD_SCENE_ON_HOT_SWAP 1

// ── Scene objects ──────────────────────────────────────────────────────────
//
// The scene nodes the game uses. Each id is matched to a node of
// media/bundle/scene.toml BY NAME (GAME_OBJECTS at the top of game.c), and
// doubles as the object's pose slot. To use another node, add an id here and
// a row there.
typedef enum game_object_id {
    GAME_OBJ_BALL,
    GAME_OBJ_GROUND,
    GAME_OBJ_COUNT,
} game_object_id;

// ── Events for the page ────────────────────────────────────────────────────
//
// Ids sent with runtime_send_event(). dom/game.js has the matching table and
// decides how to show them.
enum {
    GAME_EVENT_RESET = 1, // the ball was put back where the scene has it
    GAME_EVENT_EDGE = 2,  // the ball reached the edge of the ground
};

// ── Tuning. Speeds are per second, so they do not depend on APP_STEP_HZ. ───

static constexpr float BALL_SPEED = 4.0f; // metres per second while a key is held

// Both meshes in the scene are unit-sized primitives (a sphere of diameter 1,
// a 1 × 1 plane), so a node's SCALE is its size in metres.
static constexpr float UNIT_SPHERE_RADIUS = 0.5f;
static constexpr float UNIT_PLANE_HALF = 0.5f;

// ── State ──────────────────────────────────────────────────────────────────
//
// Everything your game remembers between steps, apart from object poses
// (those are the runtime's: runtime_get_object). The runtime keeps one of
// these and hands it to every hook.
typedef struct game_state {
    // The ball is against the edge of the ground, so that GAME_EVENT_EDGE is
    // sent when it arrives there, not on every step it stays.
    bool at_edge;
} game_state;

#endif // GAME_H
