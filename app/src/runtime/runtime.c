// RUNTIME: shared by every game; your game goes in app/src/game/ and dom/game.js
//
// runtime.c — the step loop around your game's hooks: reads the bridge rings,
// keeps the objects and keys, calls the game, publishes snapshots. See
// runtime.h for the contract.

#include "runtime/runtime.h"

#include <assert.h>
#include <emscripten/emscripten.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "game/game.h"
#include "runtime/bridge.h"
#include "runtime/math3d.h"

// ── Talking to the other threads ───────────────────────────────────────────

// Tells the renderer that scene node `name` now follows pose slot `slot`.
static void send_bind(runtime_state *runtime, uint32_t slot, const char *name) {
    bridge_record rec = {.type = BRIDGE_CMD_BIND, .step = runtime->step};
    rec.u[0] = slot;
    rec.u[1] = bridge_hash(name);
    if (!bridge_ring_push(bridge_get_ring(runtime->bridge, BRIDGE_RING_APP_TO_RENDERER), &rec)) {
        fprintf(stderr, "app: the command ring is full; \"%s\" was not bound\n", name);
    }
}

void runtime_send_event(runtime_state *runtime, uint32_t event, vec3 where) {
    bridge_record rec = {.type = BRIDGE_APP_EVENT, .step = runtime->step};
    rec.u[0] = event;
    rec.f[1] = where.x;
    rec.f[2] = where.y;
    rec.f[3] = where.z;
    // A full ring means the page is not reading (a hidden tab, say). Missing
    // a HUD message is fine, so the result is not checked.
    (void)bridge_ring_push(bridge_get_ring(runtime->bridge, BRIDGE_RING_APP_TO_DOM), &rec);
}

// ── 1. The scene (renderer → app) ──────────────────────────────────────────
//
// After loading the scene (and again for every hot-swapped app, and after
// every reload), the renderer sends SCENE_BEGIN, one SCENE_NODE per named
// node, then SCENE_READY.

void runtime_reload_scene(runtime_state *runtime) {
    if (runtime->reload_pending) {
        return; // already asked
    }
    bridge_record rec = {.type = BRIDGE_CMD_RELOAD_SCENE, .step = runtime->step};
    if (!bridge_ring_push(bridge_get_ring(runtime->bridge, BRIDGE_RING_APP_TO_RENDERER), &rec)) {
        fprintf(stderr, "app: the command ring is full; the scene was not reloaded\n");
        return;
    }
    runtime->scene_ready = false;
    runtime->reload_pending = true;
}

// A scene description is starting: the world begins again from nothing.
static void scene_begin(runtime_state *runtime, bool used_by_a_previous_app) {
    memset(runtime->objects, 0, sizeof runtime->objects);
    runtime->scene_ready = false;
    game_scene_begin(runtime, &runtime->game);

    if (!used_by_a_previous_app) {
        runtime->reload_pending = false; // this is the fresh scene
    } else if (GAME_RELOAD_SCENE_ON_HOT_SWAP) {
        // This app was hot-swapped into a scene another build has been
        // playing with. Skip its description and ask for a clean one.
        runtime_reload_scene(runtime);
    }
}

static void scene_node(runtime_state *runtime, const bridge_record *rec) {
    for (int i = 0; i < GAME_OBJ_COUNT; ++i) {
        if (rec->u[0] != bridge_hash(GAME_OBJECTS[i].name)) {
            continue;
        }
        runtime_object *object = &runtime->objects[i];
        object->found = true;
        object->start_position = (vec3){rec->f[1], rec->f[2], rec->f[3]};
        object->start_rotation = (quat){rec->f[4], rec->f[5], rec->f[6], rec->f[7]};
        object->scale = (vec3){rec->f[8], rec->f[9], rec->f[10]};
        object->position = object->start_position;
        object->rotation = object->start_rotation;
    }
}

static void scene_ready(runtime_state *runtime) {
    for (int i = 0; i < GAME_OBJ_COUNT; ++i) {
        if (!runtime->objects[i].found) {
            fprintf(stderr, "app: the scene has no node named \"%s\"\n", GAME_OBJECTS[i].name);
        } else if (GAME_OBJECTS[i].driven) {
            send_bind(runtime, (uint32_t)i, GAME_OBJECTS[i].name);
        }
    }
    runtime->scene_ready = true;
    printf("app: scene ready\n");
    game_scene_ready(runtime, &runtime->game);
}

static void read_scene(runtime_state *runtime) {
    bridge_ring *ring = bridge_get_ring(runtime->bridge, BRIDGE_RING_RENDERER_TO_APP);
    bridge_record rec;
    while (bridge_ring_pop(ring, &rec)) {
        switch (rec.type) {
        case BRIDGE_SCENE_BEGIN:
            scene_begin(runtime, rec.u[0] != 0);
            break;
        case BRIDGE_SCENE_NODE:
            if (!runtime->reload_pending) {
                scene_node(runtime, &rec);
            }
            break;
        case BRIDGE_SCENE_READY:
            if (!runtime->reload_pending) {
                scene_ready(runtime);
            }
            break;
        default:
            break; // a record type this app does not know: skip it
        }
    }
}

// ── 2. Input (dom → app) ───────────────────────────────────────────────────

static void key_event(runtime_state *runtime, uint32_t key, bool down) {
    if (key == BRIDGE_KEY_NONE || key >= BRIDGE_KEY_COUNT) {
        return;
    }
    if (down) {
        runtime->keys_down |= 1u << key;
        runtime->keys_tapped |= 1u << key;
    } else {
        runtime->keys_down &= ~(1u << key);
    }
    // Held keys are remembered either way; the game only hears about presses
    // once there is a world for them to act on.
    if (runtime->scene_ready) {
        game_key(runtime, &runtime->game, key, down);
    }
}

static void read_input(runtime_state *runtime) {
    bridge_ring *ring = bridge_get_ring(runtime->bridge, BRIDGE_RING_DOM_TO_APP);
    bridge_record rec;
    while (bridge_ring_pop(ring, &rec)) {
        switch (rec.type) {
        case BRIDGE_EV_KEY:
            key_event(runtime, rec.u[0], rec.u[1] != 0);
            break;
        default:
            break;
        }
    }
}

bool runtime_key_held(const runtime_state *runtime, uint32_t key) {
    return key < BRIDGE_KEY_COUNT &&
           (((runtime->keys_down | runtime->keys_tapped) >> key) & 1u) != 0;
}

// ── 3. The world: the game's ───────────────────────────────────────────────

runtime_object *runtime_get_object(runtime_state *runtime, uint32_t id) {
    assert(id < GAME_OBJ_COUNT);
    return &runtime->objects[id];
}

uint32_t runtime_current_step(const runtime_state *runtime) {
    return runtime->step;
}

// ── 4. Publishing ──────────────────────────────────────────────────────────

static void publish_snapshot(runtime_state *runtime, uint32_t time_us) {
    bridge_snapshot_header *snapshot = bridge_snapshot_begin(runtime->bridge, runtime->step);
    snapshot->time_us = time_us;
    snapshot->pose_count = GAME_OBJ_COUNT;

    bridge_pose *poses = bridge_snapshot_poses(snapshot);
    for (int i = 0; i < GAME_OBJ_COUNT; ++i) {
        runtime_object *object = &runtime->objects[i];
        uint32_t flags = 0;
        if (runtime->scene_ready && object->found && GAME_OBJECTS[i].driven) {
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
    bridge_snapshot_publish(runtime->bridge, snapshot);
}

// ── The step ───────────────────────────────────────────────────────────────

// The step's phases, as the stats panel lists them: their entries in the
// bridge's timing table.
enum {
    PHASE_SCENE,
    PHASE_INPUT,
    PHASE_SIMULATE,
    PHASE_PUBLISH,
};

void runtime_init(runtime_state *runtime, bridge_header *bridge) {
    *runtime = (runtime_state){.bridge = bridge};
    bridge_timing_name(bridge, PHASE_SCENE, "read scene");
    bridge_timing_name(bridge, PHASE_INPUT, "read input");
    bridge_timing_name(bridge, PHASE_SIMULATE, "simulate");
    bridge_timing_name(bridge, PHASE_PUBLISH, "publish");
    game_init(runtime, &runtime->game);
}

// While profiling: charges the time since `since` to `phase` and returns the
// time now, for the next phase to start from. Otherwise does nothing. (Reading
// the clock costs a fraction of a microsecond itself, so a phase that shows
// less than one is mostly that.)
static double lap(runtime_state *runtime, uint32_t phase, double since) {
    if (!runtime->profile) {
        return 0.0;
    }
    double now = emscripten_get_now();
    bridge_timing_add(runtime->bridge, phase, now - since);
    return now;
}

void runtime_step(runtime_state *runtime, float dt, uint32_t time_us) {
    runtime->step += 1;
    double t = runtime->profile ? emscripten_get_now() : 0.0;

    read_scene(runtime);
    t = lap(runtime, PHASE_SCENE, t);
    read_input(runtime);
    t = lap(runtime, PHASE_INPUT, t);
    if (runtime->scene_ready) {
        game_update(runtime, &runtime->game, dt);
    }
    t = lap(runtime, PHASE_SIMULATE, t);
    // Published even while there is no scene (with no pose in use): the
    // renderer paces itself by the steps it sees.
    publish_snapshot(runtime, time_us);
    runtime->keys_tapped = 0; // a tap counts for one step
    lap(runtime, PHASE_PUBLISH, t);
}
