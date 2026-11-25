// awsm-renderer-kit v0.1.1: js/settings.js, copied by the kit's scripts/sync-js.sh.
// Do not edit this copy: change the kit, then sync again.
//
// settings.js — the graphics settings and how the canvas is sized: the JS
// twin of the awsm-renderer-settings crate's page side, for pages without
// Rust.
//
// Two levers, both the user's to set, both remembered in localStorage:
//
//   resolution     the canvas renders at native resolution × this fraction
//                  (the output size). The renderer's cost grows with the
//                  number of pixels, so on a weak GPU or a high-DPI phone
//                  this is what buys the frame rate back. Changes reach the
//                  renderer as ordinary `resize` messages. Under TAA the
//                  presets lower the renderer's internal scale on top of it.
//   anti-aliasing  Off, SMAA, 4× MSAA, TAA, or TAA upscaling from 67%, 58%
//                  or 50%. It is baked into the renderer's pipelines, so a
//                  change goes to the render worker (`anti-alias`), which
//                  recompiles behind the "Compiling Pipelines" overlay.
//
// The worker owns the words and numbers: the page builds all of this from
// its `settings-options` message (the menu, the defaults per device class,
// the resolution policy, the GPU probe). The page only picks the DEFAULTS,
// from the device class (touch screen, software GPU) and the window size, and
// never over a choice the user made.
//
// Stored keys, all under the app's prefix: `res_scale` ("0.80"), `aa` (the
// mode id). `?reset` forgets them (and the stats panel's); `?aa=<id>` picks a
// mode for this session without storing it.

import {
  KIT_VERSION,
  coarsePointer,
  el,
  modal,
  queryGet,
  queryHas,
  setShown,
  storageGet,
  storageKeys,
  storageRemove,
  storageSet,
} from './kit-web.js';

// The worker → page message types this module handles.
export const SETTINGS_TYPES = [
  'settings-options',
  'gpu-info',
  'aa-compile-start',
  'aa-compile-progress',
  'aa-compile-done',
];

// ── ?reset ─────────────────────────────────────────────────────────────────

// The keys `?reset` clears that are present now: the kit's own (`res_scale`,
// `aa`, `stats`, every `stats_open_*`), the legacy pair, and the app's
// `extraKeys` (full keys). Nothing else under the prefix: a game's best
// score or progress survives.
export function resetKeys({ prefix, extraKeys = [], legacyAaKeys = null }) {
  const keys = [`${prefix}res_scale`, `${prefix}aa`, `${prefix}stats`];
  const open = `${prefix}stats_open_`;
  keys.push(...storageKeys().filter((key) => key.startsWith(open)));
  if (legacyAaKeys) keys.push(...legacyAaKeys);
  keys.push(...extraKeys);
  return keys;
}

// `?reset` in the URL forgets the stored settings, so this load starts from
// the defaults: the way out when stored choices (which override the
// device-class defaults and silence the reduced-quality notice) get in the
// way. It must run before anything reads a stored setting. Returns whether it
// did.
export function resetSettingsIfAsked(options) {
  if (!queryHas('reset')) return false;
  for (const key of resetKeys(options)) storageRemove(key);
  return true;
}

// ── The resolution policy: the twin of ResolutionPolicy / ResolutionState ──
//
// `policy` is the `resolution` of the worker's `settings-options`: minScale,
// maxScale, step, pixelBudget, minEffectiveDpr, coarseStart, softwareStart
// (or null), maxTexture. fixtures/resolution.json holds cases both twins are
// tested against.

export function clampScale(policy, scale) {
  if (Number.isNaN(scale)) return policy.maxScale;
  return Math.min(Math.max(scale, policy.minScale), policy.maxScale);
}

// The device-class ceiling for the default scale.
export function policyCap(policy, { coarse = false, software = false } = {}) {
  let cap = coarse ? policy.coarseStart : policy.maxScale;
  if (software && policy.softwareStart != null) cap = Math.min(cap, policy.softwareStart);
  return cap;
}

// The default scale for a canvas of nativeW × nativeH device pixels at `dpr`:
// native, held to the pixel budget and the ceiling, but not below the minimum
// effective pixel ratio, rounded DOWN to the step, within the range.
export function autoScale(policy, nativeW, nativeH, dpr, cap) {
  const nativePixels = nativeW * nativeH;
  const budget =
    nativePixels > policy.pixelBudget
      ? Math.max(Math.sqrt(policy.pixelBudget / nativePixels), policy.minEffectiveDpr / Math.max(dpr, 1))
      : policy.maxScale;
  const steps = Math.max(Math.round(1 / policy.step), 1);
  const stepped = Math.floor(Math.min(budget, cap) * steps) / steps;
  return clampScale(policy, stepped);
}

// autoScale for a CSS size and pixel ratio on a device class.
export function defaultScale(policy, cssW, cssH, dpr, device) {
  const ratio = Math.max(dpr, 1);
  return autoScale(policy, Math.max(cssW, 1) * ratio, Math.max(cssH, 1) * ratio, ratio, policyCap(policy, device));
}

// The backing-store size: native × scale, each side between 1 and maxTexture.
export function backingSize(nativeW, nativeH, scale, maxTexture) {
  const max = Math.max(maxTexture, 1);
  const side = (native) => Math.min(Math.max(Math.round(native * scale), 1), max);
  return { width: side(nativeW), height: side(nativeH) };
}

// A stored scale ("0.80"), clamped; null if it is not a number.
export function parseStoredScale(policy, value) {
  const scale = Number.parseFloat(value ?? '');
  return Number.isFinite(scale) ? clampScale(policy, scale) : null;
}

// A scale as the slider shows it: 0.6 → 60.
export const percent = (scale) => Math.round(scale * 100);

export class ResolutionState {
  #policy;
  #nativeW;
  #nativeH;
  #dpr;
  #cap;
  #user;
  #scale;
  #maxTexture;
  #tunedPixels = null;

  // `stored`: the stored scale or null (a stored scale is the user's and is
  // never overridden).
  constructor(policy, nativeW, nativeH, dpr, device, stored) {
    this.#policy = policy;
    this.#nativeW = Math.max(nativeW, 1);
    this.#nativeH = Math.max(nativeH, 1);
    this.#dpr = Math.max(dpr, 1);
    this.#cap = policyCap(policy, device);
    this.#user = stored !== null && stored !== undefined;
    this.#maxTexture = policy.maxTexture;
    this.#scale = this.#user ? clampScale(policy, stored) : this.autoScale();
  }

  get scale() {
    return this.#scale;
  }

  percent() {
    return percent(this.#scale);
  }

  isUser() {
    return this.#user;
  }

  get dpr() {
    return this.#dpr;
  }

  // The device-class ceiling for a default or tuned scale.
  get cap() {
    return this.#cap;
  }

  // Whether an auto-tuner's scale is in effect.
  isAutoTuned() {
    return !this.#user && this.#tunedPixels !== null;
  }

  autoScale() {
    return autoScale(this.#policy, this.#nativeW, this.#nativeH, this.#dpr, this.#cap);
  }

  backing() {
    return backingSize(this.#nativeW, this.#nativeH, this.#scale, this.#maxTexture);
  }

  // The canvas's layout size or the pixel ratio changed: the default is
  // worked out again; a scale the user chose stays. An auto-tuner's scale is
  // kept as its canvas pixels (scaleFor); a new pixel ratio forgets them.
  resized(nativeW, nativeH, dpr) {
    const ratio = Math.max(dpr, 1);
    if (ratio !== this.#dpr) this.#tunedPixels = null;
    this.#nativeW = Math.max(nativeW, 1);
    this.#nativeH = Math.max(nativeH, 1);
    this.#dpr = ratio;
    if (!this.#user) {
      this.#scale = this.#tunedPixels === null ? this.autoScale() : this.scaleFor(this.#tunedPixels);
    }
  }

  // The scale that gives about `pixels` canvas pixels at the current size,
  // within the default's limits (Dreidel Derby's #scaleFor).
  scaleFor(pixels) {
    const policy = this.#policy;
    const fit = Math.sqrt(Math.max(pixels, 0) / (this.#nativeW * this.#nativeH));
    const steps = Math.max(Math.round(1 / policy.step), 1);
    const stepped = Math.floor(Math.min(fit, this.#cap) * steps) / steps;
    const floor = Math.max(policy.minScale, Math.min(policy.minEffectiveDpr / this.#dpr, this.#cap));
    return Math.min(Math.max(stepped, floor), policy.maxScale);
  }

  // An app's auto-tuner sets the scale: ignored for a user scale, clamped to
  // the range and the device ceiling, remembered as canvas pixels. Returns
  // the scale applied, or null if nothing changed.
  setAutoScale(scale) {
    if (this.#user || !Number.isFinite(scale)) return null;
    const ceiling = Math.min(this.#cap, this.#policy.maxScale);
    const next = Math.max(Math.min(scale, ceiling), this.#policy.minScale);
    this.#tunedPixels = this.#nativeW * this.#nativeH * next * next;
    if (Math.abs(next - this.#scale) < 1e-9) return null;
    this.#scale = next;
    return next;
  }

  // Forgets the auto-tuner's scale: back to the default unless the scale is
  // the user's. Returns whether the scale changed.
  clearAutoScale() {
    this.#tunedPixels = null;
    if (this.#user) return false;
    const auto = this.autoScale();
    const changed = Math.abs(auto - this.#scale) >= 1e-9;
    this.#scale = auto;
    return changed;
  }

  // The worker's GPU report: its largest texture caps the canvas, and a
  // software adapter lowers the default. Returns whether the scale went down.
  gpuInfo({ isFallback, maxTextureDim }) {
    this.#maxTexture = Math.max(maxTextureDim >>> 0, 1);
    if (isFallback && this.#policy.softwareStart != null) {
      this.#cap = Math.min(this.#cap, this.#policy.softwareStart);
      const auto = this.autoScale();
      if (!this.#user && this.#scale > auto) {
        this.#scale = auto;
        return true;
      }
    }
    return false;
  }

  // The user moved the slider. Returns the new scale (what to store).
  setPercent(pct) {
    this.#scale = clampScale(this.#policy, (pct || 100) / 100);
    this.#user = true;
    this.#tunedPixels = null;
    return this.#scale;
  }
}

// ── The mode ───────────────────────────────────────────────────────────────

// The default for a device class: software first, then coarse, then desktop
// (the `defaults` of `settings-options`).
export function pickDefault(defaults, { coarse = false, software = false } = {}) {
  return software ? defaults.software : coarse ? defaults.coarse : defaults.desktop;
}

// The mode this session starts with, and where it came from: `?aa=` (this
// session only), else the stored id, else the device default. Ids the menu
// does not offer are ignored.
export function initialAa(options, device, stored, url) {
  const offered = (id) => options.modes.some((mode) => mode.id === id);
  if (url != null && offered(url)) return { mode: url, source: 'url' };
  if (stored != null && offered(stored)) return { mode: stored, source: 'stored' };
  const fallback = pickDefault(options.defaults, device);
  return { mode: offered(fallback) ? fallback : options.modes[0]?.id ?? fallback, source: 'default' };
}

// ── The Settings panel ─────────────────────────────────────────────────────

// The words and DOM knobs, defaulting to what the templates shipped.
export const SETTINGS_UI = {
  title: 'Settings',
  hint: 'Adjust these settings if your framerate is low.',
  // The class of the × button (the About modal's look).
  closeClass: 'about-close',
  noticeTitle: 'Display Quality Reduced',
  noticeText:
    'Display quality was reduced to keep the frame rate up on touch devices. You can adjust ' +
    'the resolution and anti-aliasing any time in Settings (bottom right).',
  compileTitle: 'Compiling Pipelines',
  compileText:
    'Rebuilding the render pipelines for the new anti-aliasing settings. The first switch in ' +
    "each direction compiles shaders; after that it's cached and instant.",
  // false: no anti-aliasing menu (an app with a fixed mode).
  showAa: true,
  // Escape that closes the Settings modal stops there (a game that pauses
  // on Escape).
  escapeStops: false,
};

export class Settings {
  #prefix;
  #canvas;
  #options;
  #ui;
  #log;
  #device;
  #resolution;
  #aa;
  // The mode of the latest `aa-compile-start`. A `done` says what runs only
  // when that start was for the current pick: otherwise it answers an older
  // one (a quick second pick between TAA presets, which raise no overlay),
  // the newer one follows, and showing it would move the menu back for a
  // moment. (Workers coalesce picks, so starts and picks need not pair up.)
  #started = null;
  #showQualityNotice;
  #onResize = () => {};
  #onAntiAlias = () => {};

  #settings;
  #qualityNotice;
  #compiling;
  #compilingLine;
  #resLabel;
  #resSlider;
  #aaSelect;

  // Reads the stored choices and works out the defaults; builds the
  // Settings modal, the reduced-quality notice and the compile overlay into
  // `container` (hidden). Call it after resetSettingsIfAsked(), once the
  // worker's `settings-options` is in, and before the canvas goes to the
  // renderer: the first size and mode come from here (backing(), aa()).
  //
  //   prefix    the app's storage prefix
  //   canvas    the <canvas> (its layout size)
  //   container where the overlays go
  //   options   the worker's `settings-options` message
  //   ui        overrides of SETTINGS_UI
  //   log       a line for the loading log (`software GPU detected …`)
  constructor({ prefix, canvas, container, options, ui = {}, log = () => {} }) {
    this.#prefix = prefix;
    this.#canvas = canvas;
    this.#options = options;
    this.#ui = { ...SETTINGS_UI, ...ui };
    this.#log = log;
    if (options.kitVersion && options.kitVersion !== KIT_VERSION) {
      console.warn(
        `awsm-renderer-kit: the worker is kit ${options.kitVersion}, these page files are ${KIT_VERSION}; ` +
          "sync them (the kit's scripts/sync-js.sh)",
      );
    }
    const policy = options.resolution;
    this.#device = { coarse: coarsePointer(), software: Boolean(options.gpu?.isFallback) };

    const rect = canvas.getBoundingClientRect();
    const dpr = Math.max(window.devicePixelRatio || 1, 1);
    const stored = parseStoredScale(policy, storageGet(`${prefix}res_scale`));
    // The software GPU is known already (the probe came with the options):
    // the state starts from a desktop's ceiling and takes the report like a
    // late one, so it logs the same line.
    this.#resolution = new ResolutionState(
      policy,
      Math.max(rect.width, 1) * dpr,
      Math.max(rect.height, 1) * dpr,
      dpr,
      { coarse: this.#device.coarse, software: false },
      stored,
    );
    if (options.gpu) this.#gpuInfo(options.gpu, false);

    const storedAa = storageGet(`${prefix}aa`);
    const { mode, source } = initialAa(options, this.#device, storedAa, queryGet('aa'));
    this.#aa = mode;
    if (queryGet('aa') !== null && source !== 'url') {
      log(`?aa=${queryGet('aa')} is not one of the modes; ignored`);
    }
    const storedAaValid = options.modes.some((m) => m.id === storedAa);
    // If a touch-device default is in effect (no stored choice replaced it),
    // quality was visibly traded for frame rate: say so once the scene is on
    // screen. That is every such load, until the user makes their own
    // choices in Settings, which are stored and replace the defaults.
    this.#showQualityNotice = this.#device.coarse && (stored === null || !storedAaValid);

    this.#build(container);
  }

  // The canvas's backing-store size in device pixels.
  backing() {
    return this.#resolution.backing();
  }

  // The chosen mode's id ('taa', 'msaa', …).
  aa() {
    return this.#aa;
  }

  // The resolution scale in effect.
  scale() {
    return this.#resolution.scale;
  }

  // Whether the resolution scale is the user's (stored, or set with the
  // slider). An auto-tuner never moves it.
  isUserScale() {
    return this.#resolution.isUser();
  }

  // devicePixelRatio (at least 1) as of the last resize.
  dpr() {
    return this.#resolution.dpr;
  }

  // An app's auto-tuner sets the canvas scale (under a mode whose lever is
  // the canvas; under TAA move the renderer's TAA render scale instead):
  // ignored for a user scale, clamped, remembered as canvas pixels across
  // resizes, never stored. Shows it and calls onResize. Returns the scale
  // applied, or null if nothing changed.
  setAutoScale(scale) {
    const applied = this.#resolution.setAutoScale(scale);
    if (applied !== null) {
      this.#showScale();
      this.#onResize(this.backing());
    }
    return applied;
  }

  // Forgets the auto-tuner's scale: back to the policy's default unless the
  // scale is the user's (call it when the cost per pixel changes, such as an
  // anti-aliasing change).
  clearAutoScale() {
    if (this.#resolution.clearAutoScale()) {
      this.#showScale();
      this.#onResize(this.backing());
    }
  }

  // Starts following the canvas size and the Settings controls.
  //   onResize({ width, height })  every new backing-store size
  //   onAntiAlias(id)              every mode the user picks
  //   openButton                   an element that opens the modal on click
  //   extraRows                    () => [elements]: the app's own rows,
  //                                inserted after the anti-aliasing row
  start({ onResize, onAntiAlias, openButton = null, extraRows = null }) {
    this.#onResize = onResize ?? (() => {});
    this.#onAntiAlias = onAntiAlias ?? (() => {});
    if (extraRows) {
      const hint = this.#settings.overlay.querySelector('.settings-hint');
      const card = this.#settings.overlay.querySelector('.settings-modal');
      for (const row of extraRows()) {
        if (hint) hint.before(row);
        else card.append(row);
      }
    }
    openButton?.addEventListener('click', () => this.open());

    const observer = new ResizeObserver((entries) => this.#canvasResized(entries[0]));
    try {
      observer.observe(this.#canvas, { box: 'device-pixel-content-box' });
    } catch {
      observer.observe(this.#canvas); // browsers without device-pixel boxes
    }

    this.#showScale();
    this.#resSlider.addEventListener('input', () => {
      const scale = this.#resolution.setPercent(Number.parseFloat(this.#resSlider.value));
      storageSet(`${this.#prefix}res_scale`, scale.toFixed(2));
      this.#showScale();
      this.#onResize(this.backing());
    });

    this.#aaSelect.value = this.#aa;
    this.#showMode();
    this.#aaSelect.addEventListener('change', () => {
      const mode = this.#aaSelect.value;
      if (!this.#options.modes.some((m) => m.id === mode) || mode === this.#aa) return;
      this.#aa = mode;
      storageSet(`${this.#prefix}aa`, mode);
      this.#showMode();
      this.#onAntiAlias(mode);
    });
  }

  open() {
    this.#settings.open();
  }

  close() {
    this.#settings.close();
  }

  // The first frames are on screen (called again after every scene reload;
  // the notice is shown once).
  ready() {
    if (this.#showQualityNotice) this.#qualityNotice.open();
    this.#showQualityNotice = false;
  }

  // A worker message: handles the kit's settings messages and returns true,
  // or returns false for anything else.
  handleMessage(msg) {
    switch (msg?.type) {
      case 'settings-options':
        return true; // taken by the constructor
      case 'gpu-info':
        this.#gpuInfo(msg, true);
        return true;
      case 'aa-compile-start':
        this.#started = msg.mode;
        this.#compilingLine.textContent = msg.label ?? msg.mode;
        if (msg.compiles !== false) this.#compiling.open();
        return true;
      case 'aa-compile-progress':
        this.#compilingLine.textContent = msg.message;
        return true;
      case 'aa-compile-done':
        this.#compiling.close();
        if (msg.taaFallback) this.#taaUnavailable(msg.taaFallback);
        // What runs now (MSAA after a TAA fallback), once it answers the
        // latest pick. Not stored: the user's choice stays theirs.
        if (this.#started === this.#aa && msg.mode && msg.mode !== this.#aa) {
          this.#aa = msg.mode;
          this.#aaSelect.value = msg.mode;
          this.#showMode();
        }
        return true;
      default:
        return false;
    }
  }

  // ── private ──

  #gpuInfo(info, resize) {
    if (this.#resolution.gpuInfo(info)) {
      this.#log(`software GPU detected — starting at ${this.#resolution.percent()}% resolution`);
      if (this.#resSlider) this.#showScale();
    }
    // Again with the real texture limit (and any lowered scale).
    if (resize) this.#onResize(this.backing());
  }

  #taaUnavailable(reason) {
    for (const option of this.#aaSelect.options) {
      if (option.value.startsWith('taa')) {
        option.disabled = true;
        option.title = `TAA is not available on this device: ${reason}`;
      }
    }
  }

  #build(container) {
    const ui = this.#ui;
    const policy = this.#options.resolution;

    // Settings: resolution, anti-aliasing, the app's rows, a hint.
    const settings = el('div', 'settings-overlay');
    settings.id = 'settings';
    const card = el('div', 'settings-modal');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', ui.title);
    card.append(this.#closeButton(), el('h2', '', ui.title));

    const resRow = el('div', 'settings-row');
    this.#resLabel = el('label', 'settings-label', 'Resolution — 100%');
    this.#resLabel.id = 'res-label';
    this.#resLabel.htmlFor = 'res-slider';
    this.#resSlider = el('input', 'res-slider');
    Object.assign(this.#resSlider, {
      id: 'res-slider',
      type: 'range',
      min: String(percent(policy.minScale)),
      max: String(percent(policy.maxScale)),
      step: String(Math.max(Math.round(policy.step * 100), 1)),
    });
    this.#resSlider.setAttribute('aria-label', 'render resolution');
    resRow.append(this.#resLabel, this.#resSlider);
    card.append(resRow);

    const aaRow = el('div', 'settings-row');
    const aaLabel = el('label', 'settings-label', 'Anti-aliasing');
    aaLabel.htmlFor = 'aa-select';
    this.#aaSelect = el('select', 'settings-select');
    this.#aaSelect.id = 'aa-select';
    this.#aaSelect.setAttribute('aria-label', 'anti-aliasing');
    for (const mode of this.#options.modes) {
      const option = el('option', '', mode.label);
      option.value = mode.id;
      option.title = mode.description;
      this.#aaSelect.append(option);
    }
    aaRow.append(aaLabel, this.#aaSelect);
    setShown(aaRow, ui.showAa);
    card.append(aaRow);

    if (ui.hint) card.append(el('p', 'settings-hint', ui.hint));
    settings.append(card);

    // The reduced-quality notice (touch devices).
    const notice = el('div', 'settings-overlay');
    notice.id = 'quality-notice';
    // Above the About modal, which may already be open when this shows.
    notice.style.zIndex = '25';
    const noticeCard = el('div', 'settings-modal');
    const ok = el('button', 'notice-ok', 'OK');
    ok.type = 'button';
    ok.dataset.close = '';
    noticeCard.append(this.#closeButton(), el('h2', '', ui.noticeTitle), el('p', 'notice-text', ui.noticeText), ok);
    notice.append(noticeCard);

    // While the renderer recompiles. It cannot be dismissed; it goes away
    // when the worker says it is done.
    const compiling = el('div', 'settings-overlay compile-overlay');
    compiling.id = 'aa-compile';
    compiling.style.zIndex = '30';
    const compilingCard = el('div', 'settings-modal');
    this.#compilingLine = el('p', 'settings-hint');
    this.#compilingLine.id = 'aa-compile-line';
    compilingCard.append(el('h2', '', ui.compileTitle), el('p', 'notice-text', ui.compileText), this.#compilingLine);
    compiling.append(compilingCard);

    container.append(settings, notice, compiling);
    this.#settings = Object.assign(modal(settings, { escapeStops: ui.escapeStops }), { overlay: settings });
    this.#qualityNotice = modal(notice, { escapeStops: ui.escapeStops });
    this.#compiling = modal(compiling, { dismissable: false });
  }

  #closeButton() {
    const button = el('button', this.#ui.closeClass, '×');
    button.type = 'button';
    button.setAttribute('aria-label', 'Close');
    button.dataset.close = '';
    return button;
  }

  // The canvas's layout size changed, or the pixel ratio did (the window
  // moved to another display).
  #canvasResized(entry) {
    const dpr = Math.max(window.devicePixelRatio || 1, 1);
    let nativeW = Math.max(entry.contentRect.width, 1) * dpr;
    let nativeH = Math.max(entry.contentRect.height, 1) * dpr;
    // Where the browser reports the exact size in device pixels, use that:
    // CSS size × ratio can be a pixel off at a fractional ratio. But only if
    // the two agree to within rounding. If they do not, the box is not in
    // device pixels (Chrome's DevTools device emulation reports CSS pixels
    // there), and the product above is the one to believe.
    const box = entry.devicePixelContentBoxSize?.[0];
    if (box && Math.abs(box.inlineSize - nativeW) < 2 && Math.abs(box.blockSize - nativeH) < 2) {
      nativeW = Math.max(box.inlineSize, 1);
      nativeH = Math.max(box.blockSize, 1);
    }
    this.#resolution.resized(nativeW, nativeH, dpr);
    this.#showScale();
    this.#onResize(this.backing());
  }

  #showScale() {
    const pct = this.#resolution.percent();
    this.#resSlider.value = String(pct);
    this.#resLabel.textContent = `Resolution — ${pct}%`;
  }

  #showMode() {
    const mode = this.#options.modes.find((m) => m.id === this.#aa);
    this.#aaSelect.title = mode?.description ?? '';
  }
}
