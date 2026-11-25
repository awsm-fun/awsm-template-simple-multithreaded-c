//! Messages from this worker to the page.
//!
//! These are the renderer's half of the `postMessage` contract. They are all
//! rare (loading progress, milestones, failures); nothing that happens every
//! frame goes through `postMessage` — that is what the bridge block is for.
//! The Settings messages (`settings-options`, `aa-compile-*`) and the stats
//! report (`stats`, about once a second) are awsm-renderer-kit's, posted
//! with its `post_to_page` / `post_report`.

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

/// `{type: 'ready'}`: the scene is on screen (after start-up, and again after
/// every reload).
pub fn post_ready() {
    post("ready", &[]);
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
