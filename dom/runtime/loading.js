// RUNTIME: shared by every game; your game goes in app/src/game/ and dom/game.js
//
// loading.js — the loading screen and the "cannot start" screen.
//
// The loading screen is in the static HTML, so it shows the moment the page
// arrives, while the wasm modules are still downloading. Progress lines from
// this page and from the render worker are appended to it, and it fades out
// once the first frames are on screen. It comes back whenever the renderer
// loads the scene again (the app asked for a reload).

import { GAME_NAME } from '../game.js';

// The newest loading lines kept on screen (older ones fade out at the top).
const MAX_LOADING_LINES = 14;

// Adds a line to the loading screen, and to the console. Every line is stamped
// with the seconds since the page started loading: the gaps between stamps
// show where a slow start spends its time, in a form a user can copy into a
// report.
export function loadingLog(message) {
  const seconds = (performance.now() / 1000).toFixed(2).padStart(6);
  const line = `[${seconds}s] ${message}`;
  console.log(`loading: ${line}`);
  const log = document.getElementById('loading-log');
  const row = document.createElement('div');
  row.textContent = line;
  log.append(row);
  while (log.childElementCount > MAX_LOADING_LINES) {
    log.firstElementChild.remove();
  }
}

// Shows the loading screen again, with an empty log: a new load is starting.
export function loadingStart() {
  document.getElementById('loading-log').replaceChildren();
  document.getElementById('loading').classList.remove('done');
}

// Fades the loading screen out (style.css). It stays in the page, hidden,
// for the next loadingStart().
export function loadingDone() {
  document.getElementById('loading').classList.add('done');
}

// The page cannot run at all (no cross-origin isolation, no WebGPU, …): show
// why, and nothing else, instead of starting into a confusing failure.
export function fatal(message) {
  loadingLog(`FATAL: ${message}`);
  loadingDone();
  document.getElementById('ui').hidden = true;
  const screen = document.createElement('div');
  screen.className = 'hud fatal';
  const detail = document.createElement('span');
  detail.textContent = message;
  screen.append(`${GAME_NAME} — cannot start\n\n`, detail);
  document.body.append(screen);
}
