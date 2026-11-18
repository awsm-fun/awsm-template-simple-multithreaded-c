// app.c — the demo: a ball you roll around the ground with the keyboard.
//
// Every fixed step (app_step) does four things, in order:
//
//   1. read what the renderer says about the scene  (renderer → app ring)
//   2. read what the user did                        (dom → app ring)
//   3. move the world                                (simulate)
//   4. publish the result                            (a snapshot of poses)
//
// Your game goes in simulate().

#include "app.h"

#include <stdio.h>
#include <string.h>

// ── Scene objects, by name ─────────────────────────────────────────────────
//
// How the app knows which scene node is which: each app_object_id is matched
// to the node with this name in media/bundle/scene.toml. (Names cross the
// bridge as hashes; see bridge_hash() in bridge.h.)
//
// A `driven` object is moved by the app: it is bound to a pose slot (the slot
// number is simply the object's id) and its pose is published every step.
// The others are only looked at: where the scene put them and how big.
static const struct {
    const char *name;
    bool driven;
} OBJECTS[APP_OBJ_COUNT] = {
    [APP_OBJ_BALL] = {.name = "Ball", .driven = true},
    [APP_OBJ_GROUND] = {.name = "Ground", .driven = false},
};

// ── Tuning. Speeds are per second, so they do not depend on APP_STEP_HZ. ───

constexpr float BALL_SPEED = 4.0f; // metres per second while a key is held

// Both meshes in the scene are unit-sized primitives (a sphere of diameter 1,
// a 1 × 1 plane), so a node's SCALE is its size in metres.
constexpr float UNIT_SPHERE_RADIUS = 0.5f;
constexpr float UNIT_PLANE_HALF = 0.5f;

// ── Talking to the other threads ───────────────────────────────────────────

// Tells the renderer that scene node `name` now follows pose slot `slot`.
static void send_bind(app_state *app, uint32_t slot, const char *name) {
    bridge_record rec = {.type = BRIDGE_CMD_BIND, .step = app->step};
    rec.u[0] = slot;
    rec.u[1] = bridge_hash(name);
    if (!bridge_ring_push(bridge_get_ring(app->bridge, BRIDGE_RING_APP_TO_RENDERER), &rec)) {
        fprintf(stderr, "app: the command ring is full; \"%s\" was not bound\n", name);
    }
}

// Tells the page that something happened (APP_EVENT_* in app.h).
static void send_event(app_state *app, uint32_t event, vec3 where) {
    bridge_record rec = {.type = BRIDGE_APP_EVENT, .step = app->step};
    rec.u[0] = event;
    rec.f[1] = where.x;
    rec.f[2] = where.y;
    rec.f[3] = where.z;
    // A full ring means the page is not reading (a hidden tab, say). Missing
    // a HUD message is fine, so the result is not checked.
    (void)bridge_ring_push(bridge_get_ring(app->bridge, BRIDGE_RING_APP_TO_DOM), &rec);
}

// ── 1. The scene (renderer → app) ──────────────────────────────────────────
//
// After loading the scene (and again for every hot-swapped app, and after
// every reload), the renderer sends SCENE_BEGIN, one SCENE_NODE per named
// node, then SCENE_READY.

void app_reload_scene(app_state *app) {
    if (app->reload_pending) {
        return; // already asked
    }
    bridge_record rec = {.type = BRIDGE_CMD_RELOAD_SCENE, .step = app->step};
    if (!bridge_ring_push(bridge_get_ring(app->bridge, BRIDGE_RING_APP_TO_RENDERER), &rec)) {
        fprintf(stderr, "app: the command ring is full; the scene was not reloaded\n");
        return;
    }
    app->scene_ready = false;
    app->reload_pending = true;
}

// A scene description is starting: the world begins again from nothing.
// Reset your own game state here too (score, level, …).
static void scene_begin(app_state *app, bool used_by_a_previous_app) {
    memset(app->objects, 0, sizeof app->objects);
    app->scene_ready = false;
    app->at_edge = false;

    if (!used_by_a_previous_app) {
        app->reload_pending = false; // this is the fresh scene
    } else if (APP_RELOAD_SCENE_ON_HOT_SWAP) {
        // This app was hot-swapped into a scene another build has been
        // playing with. Skip its description and ask for a clean one.
        app_reload_scene(app);
    }
}

static void scene_node(app_state *app, const bridge_record *rec) {
    for (int i = 0; i < APP_OBJ_COUNT; ++i) {
        if (rec->u[0] != bridge_hash(OBJECTS[i].name)) {
            continue;
        }
        app_object *object = &app->objects[i];
        object->found = true;
        object->start_position = (vec3){rec->f[1], rec->f[2], rec->f[3]};
        object->start_rotation = (quat){rec->f[4], rec->f[5], rec->f[6], rec->f[7]};
        object->scale = (vec3){rec->f[8], rec->f[9], rec->f[10]};
        object->position = object->start_position;
        object->rotation = object->start_rotation;
    }
}

static void scene_ready(app_state *app) {
    for (int i = 0; i < APP_OBJ_COUNT; ++i) {
        if (!app->objects[i].found) {
            fprintf(stderr, "app: the scene has no node named \"%s\"\n", OBJECTS[i].name);
        } else if (OBJECTS[i].driven) {
            send_bind(app, (uint32_t)i, OBJECTS[i].name);
        }
    }
    app->scene_ready = true;
    printf("app: scene ready\n");
}

static void read_scene(app_state *app) {
    bridge_ring *ring = bridge_get_ring(app->bridge, BRIDGE_RING_RENDERER_TO_APP);
    bridge_record rec;
    while (bridge_ring_pop(ring, &rec)) {
        switch (rec.type) {
        case BRIDGE_SCENE_BEGIN:
            scene_begin(app, rec.u[0] != 0);
            break;
        case BRIDGE_SCENE_NODE:
            if (!app->reload_pending) {
                scene_node(app, &rec);
            }
            break;
        case BRIDGE_SCENE_READY:
            if (!app->reload_pending) {
                scene_ready(app);
            }
            break;
        default:
            break; // a record type this app does not know: skip it
        }
    }
}

// ── 2. Input (dom → app) ───────────────────────────────────────────────────

// Space: back to where the scene has the ball.
static void reset_ball(app_state *app) {
    app_object *ball = &app->objects[APP_OBJ_BALL];
    ball->position = ball->start_position;
    ball->rotation = ball->start_rotation;
    ball->teleported = true; // a jump, not a very fast roll
    app->at_edge = false;
    send_event(app, APP_EVENT_RESET, ball->position);
}

static void key_event(app_state *app, uint32_t key, bool down) {
    if (key == BRIDGE_KEY_NONE || key >= BRIDGE_KEY_COUNT) {
        return;
    }
    if (down) {
        app->keys_down |= 1u << key;
        app->keys_tapped |= 1u << key;
    } else {
        app->keys_down &= ~(1u << key);
    }
    // One-off actions go here; keys that act for as long as they are held
    // are polled with app_key_held() in simulate().
    if (!down || !app->scene_ready) {
        return;
    }
    if (key == BRIDGE_KEY_SPACE) {
        reset_ball(app);
    } else if (key == BRIDGE_KEY_R) {
        app_reload_scene(app);
    }
}

static void read_input(app_state *app) {
    bridge_ring *ring = bridge_get_ring(app->bridge, BRIDGE_RING_DOM_TO_APP);
    bridge_record rec;
    while (bridge_ring_pop(ring, &rec)) {
        switch (rec.type) {
        case BRIDGE_EV_KEY:
            key_event(app, rec.u[0], rec.u[1] != 0);
            break;
        default:
            break;
        }
    }
}

bool app_key_held(const app_state *app, uint32_t key) {
    return key < BRIDGE_KEY_COUNT && (((app->keys_down | app->keys_tapped) >> key) & 1u) != 0;
}

// ── 3. The world ───────────────────────────────────────────────────────────

// Keeps the ball on the ground (an axis-aligned rectangle centred on the
// Ground node), and tells the page when it first touches the edge.
static void keep_on_ground(app_state *app, app_object *ball) {
    const app_object *ground = &app->objects[APP_OBJ_GROUND];
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
    if (at_edge && !app->at_edge) {
        send_event(app, APP_EVENT_EDGE, ball->position);
    }
    app->at_edge = at_edge;
}

// Held direction keys roll the ball over the ground.
static void move_ball(app_state *app, float dt) {
    app_object *ball = &app->objects[APP_OBJ_BALL];
    if (!ball->found) {
        return;
    }

    // The scene's camera looks along -Z, so on screen +X is right and -Z is
    // away from the viewer.
    vec3 direction = {0.0f, 0.0f, 0.0f};
    if (app_key_held(app, BRIDGE_KEY_W) || app_key_held(app, BRIDGE_KEY_UP)) {
        direction.z -= 1.0f;
    }
    if (app_key_held(app, BRIDGE_KEY_S) || app_key_held(app, BRIDGE_KEY_DOWN)) {
        direction.z += 1.0f;
    }
    if (app_key_held(app, BRIDGE_KEY_A) || app_key_held(app, BRIDGE_KEY_LEFT)) {
        direction.x -= 1.0f;
    }
    if (app_key_held(app, BRIDGE_KEY_D) || app_key_held(app, BRIDGE_KEY_RIGHT)) {
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

    keep_on_ground(app, ball);
}

// Runs once per fixed step, once the scene is ready.
static void simulate(app_state *app, float dt) {
    // ── Your game logic goes here. ─────────────────────────────────────────
    // Move objects by setting their `position` and `rotation`; the ones
    // marked `driven` in OBJECTS are published for you after this returns.
    move_ball(app, dt);
}

// ── 4. Publishing ──────────────────────────────────────────────────────────

static void publish_snapshot(app_state *app, uint32_t time_us) {
    bridge_snapshot_header *snapshot = bridge_snapshot_begin(app->bridge, app->step);
    snapshot->time_us = time_us;
    snapshot->pose_count = APP_OBJ_COUNT;

    bridge_pose *poses = bridge_snapshot_poses(snapshot);
    for (int i = 0; i < APP_OBJ_COUNT; ++i) {
        app_object *object = &app->objects[i];
        uint32_t flags = 0;
        if (app->scene_ready && object->found && OBJECTS[i].driven) {
            flags = (uint32_t)BRIDGE_POSE_ACTIVE;
            if (object->teleported) {
                flags |= (uint32_t)BRIDGE_POSE_TELEPORT;
            }
        }
        poses[i] = (bridge_pose){
            .position = {object->position.x, object->position.y, object->position.z},
            .rotation = {object->rotation.x, object->rotation.y, object->rotation.z,
                         object->rotation.w},
            .flags = flags,
        };
        object->teleported = false;
    }
    bridge_snapshot_publish(app->bridge, snapshot);
}

// ── Public API ─────────────────────────────────────────────────────────────

void app_init(app_state *app, bridge_header *bridge) {
    *app = (app_state){.bridge = bridge};
}

void app_step(app_state *app, float dt, uint32_t time_us) {
    app->step += 1;

    read_scene(app);
    read_input(app);
    if (app->scene_ready) {
        simulate(app, dt);
    }
    // Published even while there is no scene (with no pose in use): the
    // renderer paces itself by the steps it sees.
    publish_snapshot(app, time_us);
    app->keys_tapped = 0; // a tap counts for one step
}
