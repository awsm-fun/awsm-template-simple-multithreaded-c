// main.js — the main thread. Owns the page: the canvas, the keyboard, the HUD,
// and the two workers. No framework, no build step.
//
//   renderer/worker.js  draws into the canvas (transferred to it as an
//                       OffscreenCanvas) from the snapshots the app publishes
//   app/worker.js       runs the C app; all logic and state live there
//
// The app's memory holds the shared "bridge block" (see app/src/bridge.h).
// When the app worker reports `ready`, this thread forwards its memory to the
// renderer (`attach`) and keeps its own view (bridge.js) to send keys and read
// app events and stats. After that, nothing per-frame goes through
// postMessage; the only messages are rare ones, such as a Settings change.
//
// The panels over the canvas each have a module of their own:
//
//   loading.js    the loading screen and the "cannot start" screen
//   settings.js   resolution and anti-aliasing (the Settings button), and
//                 the canvas size that follows from them
//   stats.js      the stats panel (the Stats button)
//   about.js      the About button
//
// This file wires them to the workers, and owns the keyboard and the HUD.

import { Bridge, KEY, RECORD } from './bridge.js';
import { installAbout } from './about.js';
import { APP_NAME, fatal, loadingDone, loadingLog, loadingStart } from './loading.js';
import { Settings, resetSettingsIfAsked } from './settings.js';
import { installStats } from './stats.js';

// KeyboardEvent.code → bridge key. Codes name physical keys, so W/A/S/D sit in
// the same place on every keyboard layout.
const KEY_CODES = {
  KeyW: KEY.W,
  KeyA: KEY.A,
  KeyS: KEY.S,
  KeyD: KEY.D,
  ArrowUp: KEY.UP,
  ArrowDown: KEY.DOWN,
  ArrowLeft: KEY.LEFT,
  ArrowRight: KEY.RIGHT,
  KeyR: KEY.R,
  Space: KEY.SPACE,
};

// What the HUD calls each app event. The ids are defined by the app
// (APP_EVENT_* in app/src/app.h); this page only gives them words. Nothing
// checks these numbers against app.h: change them together.
const APP_EVENT_NAMES = {
  1: 'ball put back', // APP_EVENT_RESET
  2: 'ball reached the edge', // APP_EVENT_EDGE
};

const canvas = document.getElementById('view');
const hud = document.getElementById('hud');
const errorPanel = document.getElementById('error');
const errorText = document.getElementById('error-text');

// ── HUD ───────────────────────────────────────────────────────────────────
//
// Top left: the controls, one status line and the latest app event. The
// status line goes booting… → loading scene… → running, and shows the latest
// error while there is one.

const HUD_TEXT =
  `${APP_NAME}\n` +
  'W/A/S/D or arrows: move the ball · Space: put it back · R: reload the scene\n';

// What the status line calls each source of errors.
const ERROR_NAMES = { page: 'page', renderer: 'render', app: 'app' };

let status = 'booting…';
let lastEvent = '-';

function setStatus(text) {
  status = text;
  renderHud();
}

function renderHud() {
  let line = status;
  const latest = [...errors].at(-1);
  if (latest) {
    const [source, messages] = latest;
    line = `${ERROR_NAMES[source] ?? source} error: ${messages.at(-1).split('\n')[0]}`;
  }
  hud.textContent = `${HUD_TEXT}${line}\nlast event: ${lastEvent}`;
}

// ── Errors ────────────────────────────────────────────────────────────────

// Messages by source ('page', 'renderer', 'app'), so replacing the app worker
// can clear the old app's errors without hiding the renderer's. The latest one
// also shows on the HUD's status line and in the loading log; the panel at the
// bottom has them all in full.
const errors = new Map();

function showError(source, message) {
  console.error(`[${source}]`, message);
  loadingLog(`ERROR: ${message}`);
  const list = errors.get(source) ?? [];
  list.push(message);
  errors.delete(source); // re-inserted last: the newest source shows on the HUD
  errors.set(source, list);
  renderErrors();
}

function clearErrors(source) {
  errors.delete(source);
  renderErrors();
}

function renderErrors() {
  const lines = [];
  for (const [source, list] of errors) {
    for (const message of list) lines.push(`${source}: ${message}`);
  }
  errorText.textContent = lines.join('\n\n');
  errorPanel.hidden = lines.length === 0;
  renderHud();
}

// ── Start ─────────────────────────────────────────────────────────────────

function main() {
  renderHud();
  if (!window.crossOriginIsolated) {
    // In a release build, the service-worker shim reloads the page once it is
    // installed; this first visit is expected to be un-isolated.
    const shimReloading =
      document.querySelector('script[src$="coi-serviceworker.js"]') !== null &&
      'serviceWorker' in navigator &&
      !navigator.serviceWorker.controller &&
      window.isSecureContext;
    if (shimReloading) {
      loadingLog('enabling cross-origin isolation (the page reloads once)…');
      return;
    }
    // There is nothing to fall back to: without isolation there is no shared
    // memory, and so no bridge block. Say why, rather than failing later
    // with an opaque error.
    fatal(
      'Cross-origin isolation is OFF — multithreading is unavailable, so this build cannot ' +
        'run. It needs COOP: same-origin + COEP: require-corp (sent by `task dev` and ' +
        '`task serve`, or re-imposed by coi-serviceworker.js on static hosts like GitHub ' +
        'Pages: `task build` includes a shim for that unless COI=0).',
    );
    return;
  }
  if (!('transferControlToOffscreen' in HTMLCanvasElement.prototype)) {
    fatal(
      'This browser cannot hand a canvas to a worker (OffscreenCanvas), which the renderer needs.',
    );
    return;
  }
  if (!('gpu' in navigator)) {
    fatal('This browser does not support WebGPU, which the renderer needs.');
    return;
  }

  // Before anything reads a stored setting.
  resetSettingsIfAsked();
  loadingLog('main thread booting');

  // dist/ root, so the renderer can resolve asset URLs from its worker.
  const baseUrl = new URL('./', document.baseURI).href;

  // The canvas's backing-store size, from the resolution setting. Set before
  // the canvas is transferred; after that only the renderer can change it.
  const settings = new Settings(canvas);
  let size = settings.backing();
  canvas.width = size.width;
  canvas.height = size.height;
  const offscreen = canvas.transferControlToOffscreen();

  // ── Renderer worker ──

  loadingLog('spawning render worker…');
  const renderer = new Worker('renderer/worker.js', { type: 'module' });
  renderer.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg?.type) {
      case 'progress':
        loadingLog(msg.message);
        break;
      case 'gpu-info':
        settings.gpuInfo(msg);
        break;
      // The scene is being loaded again (the app asked: R, or a hot swap).
      // The same loading screen as at start-up, until the next `ready`.
      case 'loading':
        loadingStart();
        lastEvent = '-';
        setStatus('loading scene…');
        break;
      // The scene is on screen: after start-up, and after every reload.
      case 'ready':
        loadingLog('first frames rendered — ready');
        loadingDone();
        stats.markReady();
        settings.ready();
        setStatus('running');
        break;
      case 'aa-compile-start':
        settings.compileStart(msg);
        break;
      case 'aa-compile-progress':
        settings.compileProgress(msg.message);
        break;
      case 'aa-compile-done':
        settings.compileDone();
        break;
      case 'error':
        showError('renderer', msg.message);
        break;
      default:
        console.warn('[renderer] unexpected message', msg);
    }
  });
  renderer.addEventListener('error', (event) => {
    showError('renderer', event.message || 'the worker failed to load (see the console)');
  });
  // The anti-aliasing comes with `init`, so the renderer is built with it
  // instead of recompiling right after start-up.
  const { msaa, smaa } = settings.antiAlias();
  const { width, height } = size;
  renderer.postMessage({ type: 'init', canvas: offscreen, baseUrl, width, height, msaa, smaa }, [
    offscreen,
  ]);

  // ── App worker ──
  //
  // `app` is the current worker plus its bridge view (null until `ready`).
  // Replaced wholesale by swapApp().

  let app = null;

  function spawnApp() {
    loadingLog('spawning app worker…');
    const entry = { worker: new Worker('app/worker.js', { type: 'module' }), bridge: null };
    app = entry;
    entry.worker.addEventListener('message', (event) => {
      if (app !== entry) return; // from a worker that has since been replaced
      const msg = event.data;
      if (msg?.type === 'ready') {
        try {
          entry.bridge = new Bridge(msg.memory, msg.bridgePtr);
        } catch (err) {
          showError('app', err.message);
          return;
        }
        loadingLog('app ready');
        renderer.postMessage({ type: 'attach', memory: msg.memory, bridgePtr: msg.bridgePtr });
      } else if (msg?.type === 'error') {
        showError('app', msg.message);
      }
    });
    entry.worker.addEventListener('error', (event) => {
      if (app !== entry) return;
      showError('app', event.message || 'the worker failed to load (see the console)');
    });
  }

  // Hot swap: replace the app worker with a freshly loaded one (the dev
  // server's reload client calls this after an app rebuild). The renderer
  // keeps showing the last frame, then resets its scene for the new app.
  function swapApp() {
    if (app) {
      app.worker.terminate();
      renderer.postMessage({ type: 'detach' });
    }
    app = null;
    // The new app starts with nothing held. A key that is still physically
    // down reaches it through the keyboard's auto-repeat.
    heldKeys.clear();
    lastEvent = '-';
    clearErrors('app');
    spawnApp();
  }

  // ── Panels ──

  const stats = installStats({ getBridge: () => app?.bridge ?? null });
  installAbout();

  // ── Settings: canvas size and anti-aliasing ──

  settings.start({
    // A new backing-store size: the window was resized, or the resolution
    // setting changed. The renderer owns the canvas now, so it resizes it
    // (and works out the camera's aspect ratio from it).
    onResize(next) {
      if (next.width === size.width && next.height === size.height) return;
      size = next;
      renderer.postMessage({ type: 'resize', width: size.width, height: size.height });
    },
    onAntiAlias({ msaa, smaa }) {
      renderer.postMessage({ type: 'anti-alias', msaa, smaa });
    },
  });

  // ── Keyboard ──
  //
  // The page only reports which keys go down and up (records on the dom → app
  // ring); what they do is decided in the app.

  // The keys the current app has been told are down.
  const heldKeys = new Set();

  // Take the keyboard from the start, so W/A/S/D work without a click first.
  // In an iframe the browser ignores this without a user gesture: then the
  // page around it has to focus the frame (awsm.fun does, once it loads), or
  // the first press on the canvas takes the keyboard (see below).
  window.focus();

  // A press on the canvas takes the keyboard. That matters inside an iframe
  // (the awsm.fun gallery shows the page in one): until the frame has focus,
  // keys go to the page around it.
  canvas.addEventListener('pointerdown', () => canvas.focus({ preventScroll: true }));

  window.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return; // leave shortcuts alone
    const key = KEY_CODES[event.code];
    if (key === undefined) return;
    event.preventDefault(); // no page scrolling on Space or the arrows
    // A held key repeats its keydown; only the first one is news. While no
    // app is listening nothing is remembered, so a key held through loading
    // is still reported (by its next repeat) once the app is up.
    const bridge = app?.bridge;
    if (!bridge || heldKeys.has(key)) return;
    heldKeys.add(key);
    bridge.sendKey(key, true);
  });

  window.addEventListener('keyup', (event) => {
    const key = KEY_CODES[event.code];
    if (key === undefined || !heldKeys.has(key)) return;
    heldKeys.delete(key);
    app?.bridge?.sendKey(key, false);
  });

  // Keys released while the page is not focused never send keyup.
  function releaseAllKeys() {
    for (const key of heldKeys) app?.bridge?.sendKey(key, false);
    heldKeys.clear();
  }
  window.addEventListener('blur', releaseAllKeys);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) releaseAllKeys();
  });

  // ── Per frame: app events (the app → dom ring) ──
  //
  // This is how the app tells the page something happened. Here the page
  // just names the event on the HUD; a real game would update its score or
  // UI here.

  function frame() {
    const start = performance.now();
    app?.bridge?.drain((record) => {
      if (record.type !== RECORD.APP_EVENT) return; // a record type this page does not know
      const id = record.u(0);
      const name = APP_EVENT_NAMES[id] ?? `event ${id}`;
      const at = [record.f(1), record.f(2), record.f(3)].map((v) => v.toFixed(1)).join(', ');
      lastEvent = `${name} at (${at})`;
      renderHud();
    });
    // For the stats panel: what this thread spends per frame.
    stats.pageFrame(performance.now() - start);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ── Go ──

  window.__awsm = {
    swapApp,
    get bridge() {
      return app?.bridge ?? null;
    },
  };
  spawnApp();
  setStatus('loading scene…');
}

try {
  main();
} catch (err) {
  showError('page', err instanceof Error ? err.stack || err.message : String(err));
}
