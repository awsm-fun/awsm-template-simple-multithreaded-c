// awsm-renderer-kit v0.1.3: js/kit-web.js, copied by the kit's scripts/sync-js.sh.
// Do not edit this copy: change the kit, then sync again.
//
// kit-web.js — browser helpers shared by settings.js and stats.js: the twin
// of the awsm-renderer-kit-web crate.
//
// Everything tolerates the browser saying no: localStorage can be missing or
// throw (privacy modes, storage disabled), and then nothing is remembered and
// the defaults apply on every load.

export function storageGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {}
}

export function storageRemove(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {}
}

// Every key currently stored (empty without storage).
export function storageKeys() {
  try {
    return Object.keys(window.localStorage);
  } catch {
    return [];
  }
}

// A stored "1" / "0", or null if there is none.
export function storedBool(key) {
  const value = storageGet(key);
  return value === '1' ? true : value === '0' ? false : null;
}

export function storeBool(key, value) {
  storageSet(key, value ? '1' : '0');
}

// `?name` in the page's URL, with or without a value.
export function queryHas(name) {
  return new URLSearchParams(window.location.search).has(name);
}

// The value of `?name=…`, or null.
export function queryGet(name) {
  return new URLSearchParams(window.location.search).get(name);
}

// A touch / coarse-pointer device (phones, tablets): the device class that
// starts with lower graphics defaults.
export function coarsePointer() {
  return window.matchMedia?.('(pointer: coarse)').matches ?? false;
}

// The kit's version: the worker's `settings-options` carries its own
// (`kitVersion`), and the page warns when the two differ (a project that
// bumped the crates' tag without syncing these files, or the reverse).
// scripts/check.sh keeps it equal to Cargo.toml's.
export const KIT_VERSION = '0.1.3';

// Shows or hides `element`: its `hidden` attribute, and an inline
// `display: none` while hidden. The attribute alone loses to any rule that
// sets `display` (`.settings-overlay { display: flex }`), so the inline style
// is what really hides it; showing removes it, so the stylesheet's own
// `display` applies. The twin of the crate's `dom::set_shown`.
export function setShown(element, shown) {
  element.hidden = !shown;
  if (shown) element.style.removeProperty('display');
  else element.style.display = 'none';
}

// A new element with a class name and optional text.
export function el(tag, className = '', text = null) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== null) element.textContent = text;
  return element;
}

// The behaviour every kit overlay shares (the twin of the crate's `Modal`):
// returns { open(), close(), isOpen() } for `overlay`, shown and hidden by
// setShown(). A dismissable overlay also closes on any of its
// [data-close] buttons, on a click on the backdrop itself (not on the card in
// it), and on Escape; `escapeStops` stops that Escape there, so a game that
// also listens for Escape does not see it. Keys pressed inside the overlay
// stay inside it (except Escape), so a page that sends keys to a game from a
// window listener does not see the arrows that move a slider or a select.
export function modal(overlay, { dismissable = true, escapeStops = false } = {}) {
  setShown(overlay, false);
  overlay.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') event.stopPropagation();
  });
  const open = () => setShown(overlay, true);
  const close = () => setShown(overlay, false);
  if (dismissable) {
    for (const button of overlay.querySelectorAll('[data-close]')) {
      button.addEventListener('click', close);
    }
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close();
    });
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !overlay.hidden) {
        close();
        if (escapeStops) event.stopImmediatePropagation();
      }
    });
  }
  return { open, close, isOpen: () => !overlay.hidden };
}
