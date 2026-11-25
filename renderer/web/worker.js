// Entry script of the render worker.
//
// The page starts it with
//
//     new Worker('renderer/worker.js', { type: 'module' })
//
// and the build puts this file next to `renderer.js` and `renderer_bg.wasm`,
// the wasm-bindgen output of the Rust crate in `renderer/`. Everything of
// substance happens in that Rust code. This file only loads it and passes the
// page's messages on:
//
//     { type: 'init', canvas, baseUrl, width, height, aa }  →  init(...)
//     { type: 'resize', width, height }                     →  resize(...)
//     { type: 'attach', memory, bridgePtr }                 →  attach(...)
//     { type: 'detach' }                                    →  detach()
//     { type: 'anti-alias', mode }, { type: 'stats-view', … },
//     { type: 'stats-page', … }                             →  kit(message)
//
// The last three are awsm-renderer-kit's (Settings and the stats panel),
// passed on whole. Messages back to the page (`settings-options`, `loading`,
// `progress`, `ready`, `aa-compile-start`, `aa-compile-progress`,
// `aa-compile-done`, `stats`, `error`) are posted by the Rust code itself;
// the only one sent from here is `error`.

import loadWasm, { init, resize, attach, detach, kit } from './renderer.js';

// The page does not wait for the wasm module before it starts sending, so
// messages can arrive while the module is still downloading and compiling.
// They are kept here, in order, and delivered once it is ready.
let queued = [];
let ready = false;

function reportError(error) {
    const message = error instanceof Error ? error.message : String(error);
    self.postMessage({ type: 'error', message: `render worker: ${message}` });
}

function deliver(message) {
    try {
        switch (message.type) {
            case 'init':
                init(
                    message.canvas,
                    message.baseUrl,
                    message.width,
                    message.height,
                    String(message.aa),
                );
                break;
            case 'resize':
                resize(message.width, message.height);
                break;
            case 'anti-alias':
            case 'stats-view':
            case 'stats-page':
                kit(message);
                break;
            case 'attach':
                attach(message.memory, message.bridgePtr);
                break;
            case 'detach':
                detach();
                break;
            default:
                console.warn('render worker: ignoring unknown message', message);
        }
    } catch (error) {
        reportError(error);
    }
}

// Installed before anything asynchronous happens, so no message is missed.
self.onmessage = (event) => {
    if (ready) {
        deliver(event.data);
    } else if (queued) {
        queued.push(event.data);
    }
};

// Failures that happen outside a message handler (in the frame callback, or
// in the asynchronous scene load) surface as these two events. Forward them,
// so the page hears about every failure through the same `error` message.
//
// When the Rust code panics it posts its own `error` first, with the panic
// message, and then aborts; the abort arrives here as a second, less specific
// error ("unreachable"). The first message is the informative one.
self.addEventListener('error', (event) => reportError(event.error ?? event.message));
self.addEventListener('unhandledrejection', (event) => reportError(event.reason));

loadWasm().then(
    () => {
        ready = true;
        const messages = queued;
        queued = null;
        messages.forEach(deliver);
    },
    (error) => {
        // Without the module nothing can be delivered; drop what was queued.
        queued = null;
        reportError(error);
    },
);
