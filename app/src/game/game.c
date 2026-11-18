// YOUR GAME: start here
//
// game.c — the demo: a ball you roll around the ground with the keyboard.
//
// The runtime calls the game_* hooks below (see game.h for the list); your game
// loop is game_update(). Objects move by setting the `position` and
// `rotation` of runtime_get_object(...); the runtime publishes them.

#include "game/game.h"

#include <stdint.h>

#include "runtime/bridge.h"
#include "runtime/math3d.h"
#include "runtime/runtime.h"

// ── Scene objects, by name ─────────────────────────────────────────────────
//
// How the runtime knows which scene node is which: each GAME_OBJ_* id is
// matched to the node with this name in media/bundle/scene.toml.
//
// A `driven` object is moved by the game: the runtime binds it to a pose slot
// and publishes its pose every step. The others are only looked at: where the
// scene put them and how big.
const runtime_object_def GAME_OBJECTS[GAME_OBJ_COUNT] = {
    [GAME_OBJ_BALL] = {.name = "Ball", .driven = true},
    [GAME_OBJ_GROUND] = {.name = "Ground", .driven = false},
};

// ── The scene ──────────────────────────────────────────────────────────────

void game_init(runtime_state *runtime, game_state *game) {
    (void)runtime;
    *game = (game_state){0};
}

void game_scene_begin(runtime_state *runtime, game_state *game) {
    (void)runtime;
    game->at_edge = false;
}

void game_scene_ready(runtime_state *runtime, game_state *game) {
    // Nothing to do in the demo: every object starts where the scene has it.
    (void)runtime;
    (void)game;
}

// ── Input ──────────────────────────────────────────────────────────────────

// Space: back to where the scene has the ball.
static void reset_ball(runtime_state *runtime, game_state *game) {
    runtime_object *ball = runtime_get_object(runtime, GAME_OBJ_BALL);
    ball->position = ball->start_position;
    ball->rotation = ball->start_rotation;
    ball->teleported = true; // a jump, not a very fast roll
    game->at_edge = false;
    runtime_send_event(runtime, GAME_EVENT_RESET, ball->position);
}

void game_key(runtime_state *runtime, game_state *game, uint32_t key, bool down) {
    // One-off actions go here; keys that act for as long as they are held
    // are polled with runtime_key_held() in game_update().
    if (!down) {
        return;
    }
    if (key == BRIDGE_KEY_SPACE) {
        reset_ball(runtime, game);
    } else if (key == BRIDGE_KEY_R) {
        runtime_reload_scene(runtime);
    }
}

// ── The world ──────────────────────────────────────────────────────────────

// Keeps the ball on the ground (an axis-aligned rectangle centred on the
// Ground node), and tells the page when it first touches the edge.
static void keep_on_ground(runtime_state *runtime, game_state *game, runtime_object *ball) {
    const runtime_object *ground = runtime_get_object(runtime, GAME_OBJ_GROUND);
    if (!ground->found) {
        return; // no ground in this scene: nothing to stay on
    }
    float radius = UNIT_SPHERE_RADIUS * ball->scale.x;
    float reach_x = UNIT_PLANE_HALF * ground->scale.x - radius;
    float reach_z = UNIT_PLANE_HALF * ground->scale.z - radius;
    vec3 centre = ground->start_position;
    vec3 inside = ball->position;
    inside.x = clampf(inside.x, centre.x - reach_x, centre.x + reach_x);
    inside.z = clampf(inside.z, centre.z - reach_z, centre.z + reach_z);

    bool at_edge = inside.x != ball->position.x || inside.z != ball->position.z;
    ball->position = inside;
    if (at_edge && !game->at_edge) {
        runtime_send_event(runtime, GAME_EVENT_EDGE, ball->position);
    }
    game->at_edge = at_edge;
}

// Held direction keys roll the ball over the ground.
static void move_ball(runtime_state *runtime, game_state *game, float dt) {
    runtime_object *ball = runtime_get_object(runtime, GAME_OBJ_BALL);
    if (!ball->found) {
        return;
    }

    // The scene's camera looks along -Z, so on screen +X is right and -Z is
    // away from the viewer.
    vec3 direction = {0.0f, 0.0f, 0.0f};
    if (runtime_key_held(runtime, BRIDGE_KEY_W) || runtime_key_held(runtime, BRIDGE_KEY_UP)) {
        direction.z -= 1.0f;
    }
    if (runtime_key_held(runtime, BRIDGE_KEY_S) || runtime_key_held(runtime, BRIDGE_KEY_DOWN)) {
        direction.z += 1.0f;
    }
    if (runtime_key_held(runtime, BRIDGE_KEY_A) || runtime_key_held(runtime, BRIDGE_KEY_LEFT)) {
        direction.x -= 1.0f;
    }
    if (runtime_key_held(runtime, BRIDGE_KEY_D) || runtime_key_held(runtime, BRIDGE_KEY_RIGHT)) {
        direction.x += 1.0f;
    }
    direction = vec3_normalize(direction); // diagonals are no faster
    if (direction.x == 0.0f && direction.z == 0.0f) {
        return;
    }

    float distance = BALL_SPEED * dt;
    ball->position = vec3_add(ball->position, vec3_scale(direction, distance));

    // Roll without slipping: turn by distance / radius around the horizontal
    // axis at right angles to the direction of travel (up × direction).
    vec3 axis = {direction.z, 0.0f, -direction.x};
    float radius = UNIT_SPHERE_RADIUS * ball->scale.x;
    quat roll = quat_from_axis_angle(axis, distance / radius);
    ball->rotation = quat_normalize(quat_mul(roll, ball->rotation));

    keep_on_ground(runtime, game, ball);
}

void game_update(runtime_state *runtime, game_state *game, float dt) {
    // ── Your game logic goes here. ─────────────────────────────────────────
    move_ball(runtime, game, dt);
}
