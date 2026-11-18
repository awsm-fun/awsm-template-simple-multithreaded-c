// RUNTIME: shared by every game; your game goes in app/src/game/ and dom/game.js
//
// about.js — the About button (bottom centre) and its modal. The text is in
// index.html.

import { modal } from './modal.js';

export function installAbout() {
  const about = modal(document.getElementById('about'));
  document.getElementById('about-btn').addEventListener('click', about.open);
}
