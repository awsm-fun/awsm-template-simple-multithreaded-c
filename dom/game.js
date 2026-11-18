// YOUR GAME: start here
//
// game.js — your game's side of the page: its name, the keys it listens to,
// the HUD's controls line, and what the page does with the game's events.
// The runtime (dom/runtime/main.js) owns the canvas, the workers and the
// keyboard plumbing, and reads everything it needs to know about your game
// from the exports below.

import { KEY } from './runtime/bridge.js';

// The name the HUD and the "cannot start" screen go by.
export const GAME_NAME = 'simple-multithreaded-c';

// Every localStorage key the page uses starts with this prefix (settings,
// the stats panel). localStorage is shared by everything on the same origin
// (every project under one domain, every app you run on localhost:8000), so
// CHANGE IT when you start your own project from this template, or two
// projects will overwrite each other's settings.
export const STORAGE_PREFIX = 'awsm_simple_mt_c_';

// KeyboardEvent.code → bridge key (BRIDGE_KEY_* in app/src/runtime/bridge.h).
// Only these keys reach the game; what they do is decided in
// app/src/game/game.c. Codes name physical keys, so W/A/S/D sit in the same
// place on every keyboard layout.
export const KEY_CODES = {
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

// The HUD's second line, under the name.
export const HUD_CONTROLS =
  'W/A/S/D or arrows: move the ball · Space: put it back · R: reload the scene';

// What the HUD calls each game event. The ids are defined by the game
// (GAME_EVENT_* in app/src/game/game.h); this page only gives them words.
// Nothing checks these numbers against game.h: change them together.
const GAME_EVENT_NAMES = {
  1: 'ball put back', // GAME_EVENT_RESET
  2: 'ball reached the edge', // GAME_EVENT_EDGE
};

// Called once per event the game sent (runtime_send_event in C), on the
// frame after it. `record.u(0)` is the event id and `record.f(1..3)` the world
// position it came with. `record` is reused for the next event, so copy out
// what you keep. `hud.setEvent(text)` sets the HUD's "last event" line; a real
// game would update its score or UI here.
export function onGameEvent(record, hud) {
  const id = record.u(0);
  const name = GAME_EVENT_NAMES[id] ?? `event ${id}`;
  const at = [record.f(1), record.f(2), record.f(3)].map((v) => v.toFixed(1)).join(', ');
  hud.setEvent(`${name} at (${at})`);
}
