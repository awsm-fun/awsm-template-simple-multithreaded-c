// RUNTIME: shared by every game; your game goes in app/src/game/ and dom/game.js
//
// settings.js — the graphics settings and how the canvas is sized.
//
// Two levers, both the user's to set in the Settings modal (bottom right),
// both remembered in localStorage:
//
//   resolution     the canvas renders at (native resolution × this fraction).
//                  The renderer's cost grows with the number of pixels, so on
//                  a weak GPU or a high-DPI phone this is what buys the frame
//                  rate back. Changes reach the renderer as ordinary `resize`
//                  messages.
//   anti-aliasing  Off, SMAA or 4× MSAA. It is baked into the renderer's
//                  pipelines, so a change is sent to the render worker
//                  (`anti-alias`), which recompiles behind the "Compiling
//                  Pipelines" overlay.
//
// The page only picks the DEFAULTS, from the device class (touch screen,
// software GPU) and the window size, and never over a choice the user made.

import { STORAGE_PREFIX } from '../game.js';
import { loadingLog } from './loading.js';
import { modal } from './modal.js';

// ── Stored settings ────────────────────────────────────────────────────────

// Every key starts with your game's STORAGE_PREFIX (dom/game.js).
const RES_STORAGE_KEY = `${STORAGE_PREFIX}res_scale`;
const AA_STORAGE_KEY = `${STORAGE_PREFIX}aa`;
// Whether the stats panel is open, and (with `_open_<group>` appended) which
// of its groups are expanded (stats.js).
export const STATS_STORAGE_KEY = `${STORAGE_PREFIX}stats`;

// localStorage can be missing or throw (privacy modes, storage disabled). Then
// nothing is remembered and the defaults apply on every load.
function storageGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {}
}

function storageRemove(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {}
}

// A stored "1" / "0", or null if there is none.
export function storedBool(key) {
  const value = storageGet(key);
  return value === '1' ? true : value === '0' ? false : null;
}

export function storeBool(key, value) {
  storageSet(key, value ? '1' : '0');
}

// `?reset` in the URL forgets every stored setting, so this load starts from
// the defaults: the way out when stored choices (which override the device-
// class defaults and silence the reduced-quality notice) get in the way and
// the browser's site-data settings are hard to find. It must run before
// anything reads a stored setting.
export function resetSettingsIfAsked() {
  if (!new URLSearchParams(window.location.search).has('reset')) return;
  // Everything this page ever stored: the settings, and which parts of the
  // stats panel were open.
  let keys = [];
  try {
    keys = Object.keys(window.localStorage).filter((key) => key.startsWith(STORAGE_PREFIX));
  } catch {}
  for (const key of keys) storageRemove(key);
  loadingLog('?reset — stored settings cleared, booting with defaults');
}

// A touch / coarse-pointer device (phones, tablets): the device class that
// starts with lower graphics defaults. Only the defaults: a stored choice wins.
export function coarsePointer() {
  return window.matchMedia?.('(pointer: coarse)').matches ?? false;
}

// ── Resolution ─────────────────────────────────────────────────────────────
//
// The default is native resolution, held to a PIXEL BUDGET, and lower again
// on a touch device or a software GPU. Native on every desktop is not a safe
// default: a large high-DPI screen has several times the pixels of an
// ordinary one, and the GPU's time per frame grows with them until it misses
// the display's refresh (8.3 ms at 120 Hz). So the budget is in pixels, not
// in device pixel ratio, and a small window keeps native resolution. The
// default never goes below one device pixel per CSS pixel (softer than that
// reads as blurry), so a display with a ratio of 1 keeps native resolution
// however large it is; its user has the slider.

// The slider's floor (50%; its `min` in index.html matches). Below this the
// picture turns to mush for little more speed.
const MIN_SCALE = 0.5;
// The ceiling: native resolution. Never supersampled.
const MAX_SCALE = 1.0;
// Where a touch device starts: a high pixel ratio on a mobile GPU is the case
// native resolution suits worst.
const COARSE_START_SCALE = 0.6;
// Where a software GPU starts (once the renderer has reported the adapter):
// it really cannot push pixels.
const FALLBACK_START_SCALE = 0.5;
// Canvas pixels the default resolution allows. A 1200 × 897 CSS-pixel window
// at a pixel ratio of 2 (4.3 million pixels native) defaults to about 80%.
const DEFAULT_PIXEL_BUDGET = 2_800_000;
// The largest canvas side assumed until the renderer reports the GPU's real
// limit. Every WebGPU device supports at least this.
const DEFAULT_MAX_TEX = 8192;

// A scale as the slider shows it: 0.6 → 60.
function percent(scale) {
  return Math.round(scale * 100);
}

function storedScale() {
  const value = Number.parseFloat(storageGet(RES_STORAGE_KEY) ?? '');
  return Number.isFinite(value) ? Math.min(Math.max(value, MIN_SCALE), MAX_SCALE) : null;
}

// ── Anti-aliasing ──────────────────────────────────────────────────────────
//
// One three-way choice. MSAA and SMAA together are not offered: on top of a
// 4× MSAA resolve SMAA adds almost nothing (the renderer leaves it off by
// default for that reason) and costs an extra full-screen pass. SMAA is the
// cheap anti-aliasing for when MSAA is off.

// The renderer's (msaa, smaa) pair for each mode.
const AA_MODES = {
  off: { msaa: false, smaa: false },
  smaa: { msaa: false, smaa: true },
  msaa: { msaa: true, smaa: false },
};
// The default on a desktop (fine pointer). A touch device defaults to 'off':
// like its resolution, its defaults are all about frame rate, and because that
// visibly costs quality, a notice points the user at Settings.
const AA_DEFAULT = 'msaa';

function storedAa() {
  const value = storageGet(AA_STORAGE_KEY);
  return Object.hasOwn(AA_MODES, value ?? '') ? value : null;
}

// ── The settings ───────────────────────────────────────────────────────────

export class Settings {
  #canvas;
  // Everything the canvas size is worked out from.
  #scale; // the chosen fraction of native resolution
  #maxTex = DEFAULT_MAX_TEX; // the GPU's largest texture side
  #nativeWidth; // the canvas's size in device pixels, at full resolution
  #nativeHeight;
  #dpr; // device pixels per CSS pixel (at least 1)
  #autoCap; // the device-class ceiling for the default scale
  #userScale; // whether the scale is the user's choice (never overridden)
  #aa; // a key of AA_MODES
  #showQualityNotice;
  #onResize = () => {};
  #onAntiAlias = () => {};

  #resLabel = document.getElementById('res-label');
  #resSlider = document.getElementById('res-slider');
  #aaSelect = document.getElementById('aa-select');
  #settings = modal(document.getElementById('settings'));
  #qualityNotice = modal(document.getElementById('quality-notice'));
  #compiling = modal(document.getElementById('aa-compile'), { dismissable: false });
  #compilingLine = document.getElementById('aa-compile-line');

  // Reads the stored choices and works out the defaults. Call it after
  // resetSettingsIfAsked(), and before the canvas goes to the renderer: the
  // first size and anti-aliasing come from here.
  constructor(canvas) {
    this.#canvas = canvas;
    const coarse = coarsePointer();
    const rect = canvas.getBoundingClientRect();
    this.#dpr = Math.max(window.devicePixelRatio || 1, 1);
    this.#nativeWidth = Math.max(rect.width, 1) * this.#dpr;
    this.#nativeHeight = Math.max(rect.height, 1) * this.#dpr;
    this.#autoCap = coarse ? COARSE_START_SCALE : MAX_SCALE;
    const stored = storedScale();
    this.#userScale = stored !== null;
    this.#scale = stored ?? this.#autoScale();

    this.#aa = storedAa() ?? (coarse ? 'off' : AA_DEFAULT);
    // If a touch-device default is in effect (no stored choice replaced it),
    // quality was visibly traded for frame rate: say so once the scene is on
    // screen. That is every such load, until the user makes their own
    // choices in Settings, which are stored and replace the defaults.
    this.#showQualityNotice = coarse && (stored === null || storedAa() === null);
  }

  // The canvas's backing-store size in device pixels: native × scale, each
  // side between 1 and the GPU's largest texture.
  backing() {
    const side = (native) => Math.min(Math.max(Math.round(native * this.#scale), 1), this.#maxTex);
    return { width: side(this.#nativeWidth), height: side(this.#nativeHeight) };
  }

  // The renderer's { msaa, smaa } for the chosen anti-aliasing.
  antiAlias() {
    return { ...AA_MODES[this.#aa] };
  }

  // Starts following the canvas size and the Settings controls.
  // `onResize({ width, height })` gets every new backing-store size;
  // `onAntiAlias({ msaa, smaa })` every anti-aliasing change.
  start({ onResize, onAntiAlias }) {
    this.#onResize = onResize;
    this.#onAntiAlias = onAntiAlias;

    const observer = new ResizeObserver((entries) => this.#canvasResized(entries[0]));
    try {
      observer.observe(this.#canvas, { box: 'device-pixel-content-box' });
    } catch {
      observer.observe(this.#canvas); // browsers without device-pixel boxes
    }

    document.getElementById('settings-btn').addEventListener('click', this.#settings.open);

    this.#showScale();
    this.#resSlider.addEventListener('input', () => {
      const pct = Number.parseFloat(this.#resSlider.value) || 100;
      this.#scale = Math.min(Math.max(pct / 100, MIN_SCALE), MAX_SCALE);
      this.#userScale = true;
      storageSet(RES_STORAGE_KEY, this.#scale.toFixed(2));
      this.#showScale();
      this.#onResize(this.backing());
    });

    this.#aaSelect.value = this.#aa;
    this.#aaSelect.addEventListener('change', () => {
      const mode = this.#aaSelect.value;
      if (!Object.hasOwn(AA_MODES, mode) || mode === this.#aa) return;
      this.#aa = mode;
      storageSet(AA_STORAGE_KEY, mode);
      this.#onAntiAlias(this.antiAlias());
    });
  }

  // The renderer's report on the GPU (`gpu-info`), from before the scene
  // loads: its largest texture caps the canvas, and a software adapter lowers
  // the default resolution.
  gpuInfo({ isFallback, maxTextureDim }) {
    this.#maxTex = Math.max(maxTextureDim >>> 0, 1);
    if (isFallback) {
      this.#autoCap = Math.min(this.#autoCap, FALLBACK_START_SCALE);
      if (!this.#userScale && this.#scale > this.#autoScale()) {
        this.#scale = this.#autoScale();
        this.#showScale();
        loadingLog(`software GPU detected — starting at ${percent(this.#scale)}% resolution`);
      }
    }
    // Again with the real texture limit (and any lowered scale).
    this.#onResize(this.backing());
  }

  // The first frames are on screen. (Called again after every scene reload;
  // the notice is shown once.)
  ready() {
    if (this.#showQualityNotice) this.#qualityNotice.open();
    this.#showQualityNotice = false;
  }

  // The renderer's `aa-compile-*` messages, around an anti-aliasing change.
  compileStart({ msaa, smaa }) {
    const state = (on) => (on ? 'on' : 'off');
    this.#compilingLine.textContent = `MSAA 4× ${state(msaa)} · SMAA ${state(smaa)}`;
    this.#compiling.open();
  }

  compileProgress(message) {
    this.#compilingLine.textContent = message;
  }

  compileDone() {
    this.#compiling.close();
  }

  // The default scale for the current size: native, held to the pixel budget
  // and the device-class ceiling, but not below one device pixel per CSS
  // pixel, and within the slider's range.
  #autoScale() {
    const nativePixels = this.#nativeWidth * this.#nativeHeight;
    const budget =
      nativePixels > DEFAULT_PIXEL_BUDGET
        ? Math.max(Math.sqrt(DEFAULT_PIXEL_BUDGET / nativePixels), 1 / this.#dpr)
        : MAX_SCALE;
    // Rounded DOWN to the slider's 5% step, so the thumb, its label and the
    // real scale agree (the browser would snap 81% to 80% anyway).
    const stepped = Math.floor(Math.min(budget, this.#autoCap) * 20) / 20;
    return Math.min(Math.max(stepped, MIN_SCALE), MAX_SCALE);
  }

  // The canvas's layout size changed, or the pixel ratio did (the window
  // moved to another display).
  #canvasResized(entry) {
    this.#dpr = Math.max(window.devicePixelRatio || 1, 1);
    this.#nativeWidth = Math.max(entry.contentRect.width, 1) * this.#dpr;
    this.#nativeHeight = Math.max(entry.contentRect.height, 1) * this.#dpr;
    // Where the browser reports the exact size in device pixels, use that:
    // CSS size × ratio can be a pixel off at a fractional ratio. But only if
    // the two agree to within rounding. If they do not, the box is not in
    // device pixels (Chrome's DevTools device emulation reports CSS pixels
    // there), and the product above is the one to believe.
    const box = entry.devicePixelContentBoxSize?.[0];
    if (
      box &&
      Math.abs(box.inlineSize - this.#nativeWidth) < 2 &&
      Math.abs(box.blockSize - this.#nativeHeight) < 2
    ) {
      this.#nativeWidth = Math.max(box.inlineSize, 1);
      this.#nativeHeight = Math.max(box.blockSize, 1);
    }
    // The default depends on the size (the pixel budget), so it is worked
    // out again; a scale the user chose stays.
    if (!this.#userScale) {
      this.#scale = this.#autoScale();
      this.#showScale();
    }
    this.#onResize(this.backing());
  }

  #showScale() {
    const pct = percent(this.#scale);
    this.#resSlider.value = String(pct);
    this.#resLabel.textContent = `Resolution — ${pct}%`;
  }
}
