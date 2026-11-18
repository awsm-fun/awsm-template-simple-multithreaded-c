// Tests for the app's logic, with no browser: this file plays the page and
// the renderer by writing the records they would write into the same bridge
// rings, then reads back what the app published. It is also a worked example
// of how to test your own game logic.

#include "app.h"
#include "check.h"
#include "fixed_step.h"

constexpr float DT = 1.0f / (float)APP_STEP_HZ;

// ── Stand-ins for the other two threads ────────────────────────────────────

static void push(bridge_header *bridge, int ring, const bridge_record *rec) {
    (void)bridge_ring_push(bridge_get_ring(bridge, ring), rec);
}

static void send_node(bridge_header *bridge, const char *name, vec3 position, vec3 scale) {
    bridge_record rec = {.type = BRIDGE_SCENE_NODE};
    rec.u[0] = bridge_hash(name);
    rec.f[1] = position.x;
    rec.f[2] = position.y;
    rec.f[3] = position.z;
    rec.f[7] = 1.0f; // identity rotation (x, y, z, w in f[4..7])
    rec.f[8] = scale.x;
    rec.f[9] = scale.y;
    rec.f[10] = scale.z;
    push(bridge, BRIDGE_RING_RENDERER_TO_APP, &rec);
}

// The renderer's part: describe a scene like media/bundle/scene.toml (a ball
// of diameter 1 resting on a 12 × 12 m ground). `used`: a previous app
// instance has been attached to it (BRIDGE_SCENE_BEGIN, u[0]).
static void send_scene(bridge_header *bridge, bool used) {
    bridge_record begin = {.type = BRIDGE_SCENE_BEGIN};
    begin.u[0] = used ? 1u : 0u;
    push(bridge, BRIDGE_RING_RENDERER_TO_APP, &begin);
    send_node(bridge, "Ground", (vec3){0.0f, 0.0f, 0.0f}, (vec3){12.0f, 1.0f, 12.0f});
    send_node(bridge, "Ball", (vec3){0.0f, 0.5f, 0.0f}, (vec3){1.0f, 1.0f, 1.0f});
    send_node(bridge, "Something Else", (vec3){9.0f, 9.0f, 9.0f}, (vec3){1.0f, 1.0f, 1.0f});
    push(bridge, BRIDGE_RING_RENDERER_TO_APP, &(bridge_record){.type = BRIDGE_SCENE_READY});
}

// The page's part: a key going down or up.
static void send_key(bridge_header *bridge, uint32_t key, bool down) {
    bridge_record rec = {.type = BRIDGE_EV_KEY};
    rec.u[0] = key;
    rec.u[1] = down ? 1u : 0u;
    push(bridge, BRIDGE_RING_DOM_TO_APP, &rec);
}

// Counts the next app → dom event with id `event`, discarding everything
// before it. Returns false if there is none.
static bool next_event(bridge_header *bridge, uint32_t event) {
    bridge_record rec;
    while (bridge_ring_pop(bridge_get_ring(bridge, BRIDGE_RING_APP_TO_DOM), &rec)) {
        if (rec.type == BRIDGE_APP_EVENT && rec.u[0] == event) {
            return true;
        }
    }
    return false;
}

// The ball's pose in the newest published snapshot, read as the renderer
// would find it: step N is in ring entry N & (count - 1).
static bridge_pose published_ball(bridge_header *bridge) {
    uint32_t step = atomic_load(&bridge->latest_step);
    uint32_t index = step & (bridge->snapshot_count - 1u);
    bridge_snapshot_header *snapshot =
        (bridge_snapshot_header *)(void *)((unsigned char *)bridge + bridge->snapshot_offset +
                                           index * bridge->snapshot_stride);
    CHECK(snapshot->step == step);
    CHECK(atomic_load(&snapshot->version) % 2 == 0); // stable
    return bridge_snapshot_poses(snapshot)[APP_OBJ_BALL];
}

static void run_steps(app_state *app, int count) {
    for (int i = 0; i < count; ++i) {
        app_step(app, DT, 0);
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────

static void test_scene_binds_the_ball(void) {
    bridge_header *bridge = bridge_create((float)APP_STEP_HZ);
    app_state app;
    app_init(&app, bridge);

    // Before the scene is described, steps are published but nothing is posed.
    run_steps(&app, 1);
    CHECK(atomic_load(&bridge->latest_step) == 1);
    CHECK(published_ball(bridge).flags == 0);

    send_scene(bridge, false);
    run_steps(&app, 1);
    CHECK(app.scene_ready);
    CHECK(app.objects[APP_OBJ_BALL].found);
    CHECK(app.objects[APP_OBJ_GROUND].found);

    // Exactly one BIND: the ball's slot to the node named "Ball". The ground
    // is only read, never driven.
    bridge_ring *commands = bridge_get_ring(bridge, BRIDGE_RING_APP_TO_RENDERER);
    bridge_record rec;
    CHECK(bridge_ring_pop(commands, &rec));
    CHECK(rec.type == BRIDGE_CMD_BIND);
    CHECK(rec.u[0] == APP_OBJ_BALL);
    CHECK(rec.u[1] == bridge_hash("Ball"));
    CHECK(!bridge_ring_pop(commands, &rec));

    // The ball is published where the scene has it.
    bridge_pose pose = published_ball(bridge);
    CHECK(pose.flags == BRIDGE_POSE_ACTIVE);
    CHECK_NEAR(pose.position[1], 0.5f, 1e-6f);
    CHECK_NEAR(pose.rotation[3], 1.0f, 1e-6f);

    bridge_destroy(bridge);
}

static void test_keys_move_the_ball(void) {
    bridge_header *bridge = bridge_create((float)APP_STEP_HZ);
    app_state app;
    app_init(&app, bridge);
    send_scene(bridge, false);
    run_steps(&app, 1);

    // Hold D for one second: the ball rolls right at 4 m/s, whatever the step rate.
    send_key(bridge, BRIDGE_KEY_D, true);
    run_steps(&app, APP_STEP_HZ);
    bridge_pose pose = published_ball(bridge);
    CHECK_NEAR(pose.position[0], 4.0f, 1e-3f);
    CHECK_NEAR(pose.position[2], 0.0f, 1e-6f);
    // It rolled, so it is no longer in its authored orientation, and the
    // quaternion is still unit length.
    CHECK(fabsf(pose.rotation[3]) < 0.999f);
    float length = sqrtf(pose.rotation[0] * pose.rotation[0] + pose.rotation[1] * pose.rotation[1] +
                         pose.rotation[2] * pose.rotation[2] + pose.rotation[3] * pose.rotation[3]);
    CHECK_NEAR(length, 1.0f, 1e-4f);

    // Released: it stays put.
    send_key(bridge, BRIDGE_KEY_D, false);
    run_steps(&app, 10);
    CHECK_NEAR(published_ball(bridge).position[0], pose.position[0], 1e-6f);

    // A tap that is over before the next step still moves it, for one step.
    send_key(bridge, BRIDGE_KEY_A, true);
    send_key(bridge, BRIDGE_KEY_A, false);
    run_steps(&app, 10);
    CHECK_NEAR(published_ball(bridge).position[0], pose.position[0] - 4.0f * DT, 1e-5f);
    pose = published_ball(bridge);

    // A diagonal is no faster than a straight line.
    send_key(bridge, BRIDGE_KEY_W, true);
    send_key(bridge, BRIDGE_KEY_LEFT, true);
    run_steps(&app, APP_STEP_HZ / 2);
    bridge_pose diagonal = published_ball(bridge);
    float dx = diagonal.position[0] - pose.position[0];
    float dz = diagonal.position[2] - pose.position[2];
    CHECK(dx < 0.0f && dz < 0.0f); // left, and away from the camera
    CHECK_NEAR(sqrtf(dx * dx + dz * dz), 2.0f, 1e-3f);

    bridge_destroy(bridge);
}

static void test_edge_and_reset(void) {
    bridge_header *bridge = bridge_create((float)APP_STEP_HZ);
    app_state app;
    app_init(&app, bridge);
    send_scene(bridge, false);
    run_steps(&app, 1);

    // Hold D for longer than it takes to cross the ground: the ball stops
    // with its edge on the ground's edge (6 m - 0.5 m radius), and the page
    // is told once.
    send_key(bridge, BRIDGE_KEY_D, true);
    run_steps(&app, 3 * APP_STEP_HZ);
    CHECK_NEAR(published_ball(bridge).position[0], 5.5f, 1e-4f);
    CHECK(next_event(bridge, APP_EVENT_EDGE));
    CHECK(!next_event(bridge, APP_EVENT_EDGE));
    send_key(bridge, BRIDGE_KEY_D, false);

    // Space puts it back, flagged as a teleport for exactly one step.
    send_key(bridge, BRIDGE_KEY_SPACE, true);
    run_steps(&app, 1);
    bridge_pose pose = published_ball(bridge);
    CHECK_NEAR(pose.position[0], 0.0f, 1e-6f);
    CHECK(pose.flags == (BRIDGE_POSE_ACTIVE | BRIDGE_POSE_TELEPORT));
    CHECK(next_event(bridge, APP_EVENT_RESET));
    run_steps(&app, 1);
    CHECK(published_ball(bridge).flags == BRIDGE_POSE_ACTIVE);

    bridge_destroy(bridge);
}

static void test_fixed_step(void) {
    bridge_header *bridge = bridge_create((float)APP_STEP_HZ);
    app_state app;
    app_init(&app, bridge);
    fixed_step stepper = {0};
    constexpr uint32_t STEP_US = 1'000'000 / APP_STEP_HZ;

    // Start just before the frame clock wraps, to cover the wrap as well.
    uint32_t now = UINT32_MAX - 20'000u;
    CHECK(fixed_step_advance(&stepper, &app, now) == 0); // only starts the clock

    // 60 Hz frames: each pays for 120 / 60 = 2 steps, give or take one as the
    // remainder carries over, and never loses any on the way.
    uint32_t steps = 0;
    for (int frame = 0; frame < 60; ++frame) {
        now += 16'667u;
        uint32_t ran = fixed_step_advance(&stepper, &app, now);
        CHECK(ran >= 1 && ran <= 3);
        steps += ran;
    }
    CHECK(steps == (uint32_t)APP_STEP_HZ);
    CHECK(app.step == steps);

    // The newest step stands for a moment at most one step before the frame.
    uint32_t index = app.step & (bridge->snapshot_count - 1u);
    bridge_snapshot_header *snapshot =
        (bridge_snapshot_header *)(void *)((unsigned char *)bridge + bridge->snapshot_offset +
                                           index * bridge->snapshot_stride);
    CHECK(now - snapshot->time_us < STEP_US);

    // A long stall (a background tab) is capped at 100 ms worth of steps.
    now += 5'000'000u;
    uint32_t burst = fixed_step_advance(&stepper, &app, now);
    CHECK(burst >= (uint32_t)APP_STEP_HZ / 10 && burst <= (uint32_t)APP_STEP_HZ / 10 + 1);

    bridge_destroy(bridge);
}

// The next app → renderer command, or 0 if there is none.
static uint32_t next_command(bridge_header *bridge) {
    bridge_record rec;
    return bridge_ring_pop(bridge_get_ring(bridge, BRIDGE_RING_APP_TO_RENDERER), &rec) ? rec.type
                                                                                       : 0;
}

static void test_scene_reload(void) {
    bridge_header *bridge = bridge_create((float)APP_STEP_HZ);
    app_state app;
    app_init(&app, bridge);
    send_scene(bridge, false);
    run_steps(&app, 1);
    CHECK(next_command(bridge) == BRIDGE_CMD_BIND);

    // Roll away, then R: one RELOAD_SCENE goes out and the world stops.
    send_key(bridge, BRIDGE_KEY_D, true);
    run_steps(&app, APP_STEP_HZ / 2);
    send_key(bridge, BRIDGE_KEY_R, true);
    send_key(bridge, BRIDGE_KEY_R, false);
    run_steps(&app, 5);
    CHECK(next_command(bridge) == BRIDGE_CMD_RELOAD_SCENE);
    CHECK(next_command(bridge) == 0);
    CHECK(!app.scene_ready);
    CHECK(published_ball(bridge).flags == 0); // nothing is posed meanwhile

    // The renderer describes the fresh scene: bound again, and the ball is
    // back where the scene has it although D is still held.
    send_key(bridge, BRIDGE_KEY_D, false);
    send_scene(bridge, false);
    run_steps(&app, 1);
    CHECK(app.scene_ready);
    CHECK(next_command(bridge) == BRIDGE_CMD_BIND);
    CHECK_NEAR(published_ball(bridge).position[0], 0.0f, 1e-6f);

    bridge_destroy(bridge);
}

static void test_hot_swap(void) {
    // A new app instance attaches to a scene a previous instance has used.
    bridge_header *bridge = bridge_create((float)APP_STEP_HZ);
    app_state app;
    app_init(&app, bridge);
    send_scene(bridge, true);
    run_steps(&app, 1);
#if APP_RELOAD_SCENE_ON_HOT_SWAP
    // It does not take the scene over; it asks for a clean one, once.
    CHECK(!app.scene_ready);
    CHECK(next_command(bridge) == BRIDGE_CMD_RELOAD_SCENE);
    CHECK(next_command(bridge) == 0);
    send_scene(bridge, false);
    run_steps(&app, 1);
#endif
    CHECK(app.scene_ready);
    CHECK(next_command(bridge) == BRIDGE_CMD_BIND);
    CHECK(next_command(bridge) == 0);

    bridge_destroy(bridge);
}

int main(void) {
    test_scene_binds_the_ball();
    test_keys_move_the_ball();
    test_edge_and_reset();
    test_scene_reload();
    test_hot_swap();
    test_fixed_step();
    return check_report();
}
