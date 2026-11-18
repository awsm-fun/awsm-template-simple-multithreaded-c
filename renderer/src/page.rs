//! Messages from this worker to the page.
//!
//! These are the renderer's half of the `postMessage` contract. They are all
//! rare (loading progress, milestones, a Settings change being applied,
//! failures); nothing that happens every frame goes through
//! `postMessage` — that is what the bridge block is for.

use wasm_bindgen::{JsCast, JsValue};
use web_sys::DedicatedWorkerGlobalScope;

/// `{type: 'loading'}`: a scene load is starting (the app asked for the scene
/// to be reloaded): show the loading screen again. `progress` lines follow,
/// as during start-up, and `ready` once the scene is back on screen.
pub fn post_loading() {
    post("loading", &[]);
}

/// `{type: 'progress', message}`: a line for the page's loading overlay.
pub fn post_progress(message: &str) {
    post("progress", &[("message", message.into())]);
}

/// `{type: 'gpu-info', isFallback, maxTextureDim}`: what the page needs to
/// size the canvas. A software ("fallback") adapter cannot push many pixels,
/// so the page starts it at a lower resolution; and the backing store can be
/// no larger than the GPU's largest 2D texture. Posted once, at start-up,
/// before the scene loads.
pub fn post_gpu_info(is_fallback: bool, max_texture_dim: u32) {
    post(
        "gpu-info",
        &[
            ("isFallback", is_fallback.into()),
            ("maxTextureDim", max_texture_dim.into()),
        ],
    );
}

/// `{type: 'ready'}`: the scene is on screen (after start-up, and again after
/// every reload).
pub fn post_ready() {
    post("ready", &[]);
}

/// `{type: 'aa-compile-start', msaa, smaa}`: an anti-aliasing change from the
/// page's Settings is being applied, which recompiles render pipelines. The
/// page shows a "compiling pipelines" overlay until `aa-compile-done`.
pub fn post_aa_compile_start(msaa: bool, smaa: bool) {
    post(
        "aa-compile-start",
        &[("msaa", msaa.into()), ("smaa", smaa.into())],
    );
}

/// `{type: 'aa-compile-progress', message}`: a progress line for that overlay.
pub fn post_aa_compile_progress(message: &str) {
    post("aa-compile-progress", &[("message", message.into())]);
}

/// `{type: 'aa-compile-done'}`: the change is finished, whether it worked or
/// not (a failure also posts an `error`).
pub fn post_aa_compile_done() {
    post("aa-compile-done", &[]);
}

/// `{type: 'error', message}`: something failed. Also logged to the console,
/// so the failure is visible even if the page does not show it.
pub fn post_error(message: &str) {
    web_sys::console::error_1(&JsValue::from_str(message));
    post("error", &[("message", message.into())]);
}

fn post(kind: &str, fields: &[(&str, JsValue)]) {
    let data = js_sys::Object::new();
    // Setting a plain property on a fresh object cannot fail.
    let _ = js_sys::Reflect::set(&data, &JsValue::from_str("type"), &JsValue::from_str(kind));
    for (name, value) in fields {
        let _ = js_sys::Reflect::set(&data, &JsValue::from_str(name), value);
    }
    // This module only ever runs as a dedicated worker (see web/worker.js).
    let scope: DedicatedWorkerGlobalScope = js_sys::global().unchecked_into();
    // `postMessage` only fails for data that cannot be cloned; strings,
    // numbers and booleans can.
    let _ = scope.post_message(&data);
}
