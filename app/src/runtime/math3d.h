// RUNTIME: shared by every game; your game goes in app/src/game/ and dom/game.js
//
// math3d.h — just enough vector and quaternion maths for the demo game.
//
// Conventions (the same as the renderer's): right-handed, +Y up; quaternions
// are (x, y, z, w). Everything is `static inline`, so there is no .c file.
// Grow it as your game needs, or swap in a maths library you like.

#ifndef MATH3D_H
#define MATH3D_H

#include <math.h>

typedef struct vec3 {
    float x, y, z;
} vec3;

typedef struct quat {
    float x, y, z, w;
} quat;

static inline float clampf(float value, float lo, float hi) {
    return value < lo ? lo : (value > hi ? hi : value);
}

static inline vec3 vec3_add(vec3 a, vec3 b) {
    return (vec3){a.x + b.x, a.y + b.y, a.z + b.z};
}

static inline vec3 vec3_scale(vec3 v, float s) {
    return (vec3){v.x * s, v.y * s, v.z * s};
}

static inline float vec3_length(vec3 v) {
    return sqrtf(v.x * v.x + v.y * v.y + v.z * v.z);
}

// Unit vector in the direction of `v`, or zero if `v` is (nearly) zero.
static inline vec3 vec3_normalize(vec3 v) {
    float length = vec3_length(v);
    return length > 1e-8f ? vec3_scale(v, 1.0f / length) : (vec3){0.0f, 0.0f, 0.0f};
}

static inline quat quat_identity(void) {
    return (quat){0.0f, 0.0f, 0.0f, 1.0f};
}

// The rotation by `radians` around the unit vector `axis`.
static inline quat quat_from_axis_angle(vec3 axis, float radians) {
    float s = sinf(radians * 0.5f);
    return (quat){axis.x * s, axis.y * s, axis.z * s, cosf(radians * 0.5f)};
}

// The rotation "b, then a".
static inline quat quat_mul(quat a, quat b) {
    return (quat){
        a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
        a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
        a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
        a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    };
}

// Multiplying quaternions step after step lets rounding errors build up;
// normalizing keeps the result a pure rotation.
static inline quat quat_normalize(quat q) {
    float length = sqrtf(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
    if (length < 1e-8f) {
        return quat_identity();
    }
    float k = 1.0f / length;
    return (quat){q.x * k, q.y * k, q.z * k, q.w * k};
}

#endif // MATH3D_H
