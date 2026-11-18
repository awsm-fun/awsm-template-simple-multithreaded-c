// stats.js — the stats panel (top right) and the Stats button (bottom left)
// that shows and hides it.
//
// Once a second it samples the counters the app and the renderer keep in the
// bridge block's stats section (bridge_stats in app/src/bridge.h): no
// messages, nothing measured here but the display. What it shows:
//
//   display    the display's refresh rate, measured from this thread's own
//              requestAnimationFrame timestamps (see measureRefresh).
//   render     frames presented per second, capped by the display.
//   missed     display refreshes that went by without a new frame, per
//              second and in total: the renderer was too slow (or uneven)
//              for the display, which shows as stutter. Exact: the renderer
//              sums the time between its frames (frame_span_us), and that
//              time divided by the refresh period is how many refreshes
//              went by.
//   gpu time   the GPU's time per frame, from timestamp queries: whether a
//              frame can make the refresh (8.3 ms at 120 Hz). `n/a` on a GPU
//              without timestamp queries.
//   cpu time   the render worker's CPU time per frame.
//   app time   the app's CPU time per fixed step (app_step and the rest).
//   app        fixed steps per second (120 when all is well).
//   app late   frames the renderer drew before the app had published the
//              moment they show (bridge.h, "Frame pacing"). 0 when all is
//              well. Red after LATE_WINDOWS samples in a row: a steady
//              condition, not a one-off such as a tab switch.
//
// Rates are counter differences divided by the REAL time between samples
// (performance.now()), then smoothed: a one-second timer is not really one
// second apart, and in a background tab it is throttled.

import { STATS_STORAGE_KEY, coarsePointer, storeBool, storedBool } from './settings.js';

const SAMPLE_INTERVAL_MS = 1000;
// Smoothing weight of each new sample: a real change shows within 2–3
// samples, while the readout holds steady against noise.
const EMA_ALPHA = 0.35;
// A sample window is only trusted between these lengths (ms). Shorter: two
// timer callbacks ran almost together, and the quotient is noise. Longer: the
// tab was hidden or throttled, and the window measures the stall.
const MIN_WINDOW_MS = 200;
const MAX_WINDOW_MS = 3000;
// The app-late line turns red when the app was late in this many sample
// windows in a row.
const LATE_WINDOWS = 3;
// Frames presented after the renderer reports `ready` before anything is
// counted: start-up (cold caches, the wasm engine still optimizing) reads
// several times the settled cost. Counted in frames, not time, so a stalled
// renderer keeps waiting instead of "warming up" through the stall.
const WARMUP_FRAMES = 60;
// The refresh period is the mean of the last REFRESH_SAMPLES gaps between
// this thread's animation frames, ignoring gaps more than REFRESH_INLIER away
// from the median (a frame this thread missed, a tab switch).
const REFRESH_SAMPLES = 120;
const REFRESH_MIN_SAMPLES = 30;
const REFRESH_INLIER = 0.15;
// A window whose frame span exceeds the window itself by more than this (ms)
// contains a pause from before it (a hidden tab, a debugger stop), which is
// not missed frames: the window is not counted.
const PAUSE_SLACK_MS = 250;

// Measures the display's refresh period from this thread's own animation
// frames. This thread does little per frame, so it keeps up with the display
// even when the renderer does not. Returns { periodMs() }: the period in
// milliseconds, or null until enough frames have been seen.
function measureRefresh() {
  const gaps = [];
  let last = null;
  const tick = (t) => {
    if (last !== null) {
      gaps.push(t - last);
      if (gaps.length > REFRESH_SAMPLES) gaps.shift();
    }
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  // A hidden tab runs no frames: the gap across it is not a refresh.
  document.addEventListener('visibilitychange', () => {
    last = null;
  });
  return {
    periodMs() {
      if (gaps.length < REFRESH_MIN_SAMPLES) return null;
      const sorted = [...gaps].sort((a, b) => a - b);
      const median = sorted[sorted.length >> 1];
      let sum = 0;
      let count = 0;
      for (const gap of gaps) {
        if (Math.abs(gap - median) <= median * REFRESH_INLIER) {
          sum += gap;
          count += 1;
        }
      }
      return count > 0 && sum > 0 ? sum / count : null;
    },
  };
}

// One line of the panel: the label in a fixed-width column, then the value.
const line = (label, value) => `  ${label.padEnd(12)}${value}\n`;

// The panel's first lines, which never change, and what follows them until
// there are numbers to show.
const HEAD_MAIN = `workers\n${line('main', 'ui · input')}`;
const HEAD_STARTING = HEAD_MAIN + line('render', 'starting…') + line('app', 'starting…');
const HEAD_WARMING = HEAD_MAIN + line('render', 'warming up…') + line('app', 'warming up…');

// `getBridge()` returns the current app's Bridge (or null while there is
// none). Returns { markReady() }, to call when the renderer reports `ready`.
export function installStats({ getBridge }) {
  const panel = document.getElementById('stats');
  const head = document.getElementById('stats-head');
  const lateLine = document.getElementById('stats-late');
  const button = document.getElementById('stats-btn');

  // Off by default: on a phone the panel covers a lot of the screen. A stored
  // "open" is only honoured on a desktop; on a touch device the button still
  // opens it for the session.
  const setOpen = (open) => {
    panel.hidden = !open;
    button.classList.toggle('active', open);
  };
  setOpen(!coarsePointer() && storedBool(STATS_STORAGE_KEY) === true);
  button.addEventListener('click', () => {
    const open = panel.hidden;
    setOpen(open);
    storeBool(STATS_STORAGE_KEY, open);
  });

  const show = (headText, late = '', bad = false) => {
    head.textContent = headText;
    lateLine.textContent = late;
    lateLine.classList.toggle('stats-bad', bad);
  };
  show(HEAD_STARTING);

  const refresh = measureRefresh();
  let renderReady = false;
  let bridge = null; // the Bridge the state below belongs to
  let baseline = null; // the previous sample
  let fpsEma = null;
  let stepsEma = null;
  let frameWorkEma = null;
  let stepWorkEma = null;
  let gpuEma = null;
  // Trusted windows in a row without a single GPU sample: after a few, the
  // device evidently has no timestamp queries, and the line says so.
  let gpuEmptyWindows = 0;
  // Frames the app was late for: the total since counting started, and how
  // many windows in a row had any.
  let lateTotal = 0;
  let lateWindows = 0;
  // Missed refreshes: in the latest window (per second), and the running
  // total. The total is kept signed: a sample that lands between the
  // renderer's two counter writes counts one frame early or late, and the
  // next window evens it out.
  let missedRate = null;
  let missedTotal = 0;
  // frameCount when counting could first start (see WARMUP_FRAMES).
  let warmFrame = null;

  // A hidden tab runs no frames: never turn that gap into a rate.
  document.addEventListener('visibilitychange', () => {
    baseline = null;
  });

  function sample() {
    const now = performance.now();
    const current = getBridge();
    if (current !== bridge) {
      // No app, or a new one after a hot swap. A new app's counters start
      // from zero, so nothing measured against the old one carries over.
      bridge = current;
      baseline = null;
      fpsEma = stepsEma = frameWorkEma = stepWorkEma = gpuEma = null;
      gpuEmptyWindows = 0;
      lateTotal = 0;
      lateWindows = 0;
      missedRate = null;
      missedTotal = 0;
      warmFrame = null;
    }
    if (!bridge) {
      show(HEAD_STARTING);
      return;
    }

    const stats = bridge.readStats();
    const previous = baseline;
    baseline = { at: now, ...stats };

    // Nothing is counted until the renderer is drawing for real, and then
    // only after WARMUP_FRAMES more frames. The baseline above keeps moving,
    // so the first window shown starts exactly where the warm-up ends.
    if (!renderReady) return; // still "starting…"
    warmFrame ??= stats.frameCount;
    if (((stats.frameCount - warmFrame) >>> 0) < WARMUP_FRAMES) {
      show(HEAD_WARMING);
      return;
    }
    // No trustworthy window (the first sample, or a jittered or throttled
    // gap): the baseline has been reset above; keep the last text up.
    if (!previous || !(now - previous.at >= MIN_WINDOW_MS && now - previous.at < MAX_WINDOW_MS)) {
      return;
    }
    const seconds = (now - previous.at) / 1000;

    const frames = (stats.frameCount - previous.frameCount) >>> 0;
    const steps = (stats.latestStep - previous.latestStep) >>> 0;
    const smooth = (ema, value) => (ema === null ? value : ema + (value - ema) * EMA_ALPHA);
    fpsEma = smooth(fpsEma, frames / seconds);
    stepsEma = smooth(stepsEma, steps / seconds);
    // Average CPU ms per frame and per step over the window. With no frame
    // (or step) to divide by, the previous value stays.
    if (frames > 0) {
      const ms = ((stats.frameWorkUs - previous.frameWorkUs) >>> 0) / frames / 1000;
      frameWorkEma = smooth(frameWorkEma, ms);
    }
    if (steps > 0) {
      const ms = ((stats.stepWorkUs - previous.stepWorkUs) >>> 0) / steps / 1000;
      stepWorkEma = smooth(stepWorkEma, ms);
    }
    // Average GPU ms per SAMPLED frame: the readback skips frames while one
    // is in flight, so this divides by GPU samples, not by frames.
    const gpuFrames = (stats.gpuFrameCount - previous.gpuFrameCount) >>> 0;
    if (gpuFrames > 0) {
      gpuEmptyWindows = 0;
      const ms = ((stats.gpuFrameUs - previous.gpuFrameUs) >>> 0) / gpuFrames / 1000;
      gpuEma = smooth(gpuEma, ms);
    } else {
      gpuEmptyWindows += 1;
    }
    // Refreshes that went by in the window, by the renderer's own frame
    // timestamps, minus the frames it presented in them.
    const periodMs = refresh.periodMs();
    const spanMs = ((stats.frameSpanUs - previous.frameSpanUs) >>> 0) / 1000;
    if (periodMs !== null && spanMs <= now - previous.at + PAUSE_SLACK_MS) {
      const missed = Math.round(spanMs / periodMs) - frames;
      missedTotal += missed;
      missedRate = Math.max(missed, 0) / seconds;
    }
    const displayText = periodMs === null ? 'measuring…' : `${(1000 / periodMs).toFixed(0)} Hz`;
    const missedText =
      missedRate === null
        ? '—'
        : `${missedRate.toFixed(0)}/s · ${Math.max(missedTotal, 0)} total`;

    let gpuText = '—';
    if (gpuEma !== null) gpuText = `${gpuEma.toFixed(1)} ms`;
    else if (gpuEmptyWindows >= 3) gpuText = 'n/a';
    const cpuText = frameWorkEma === null ? '—' : `${frameWorkEma.toFixed(1)} ms`;
    // In microseconds: a step of the demo takes about one.
    const appText = stepWorkEma === null ? '—' : `${(stepWorkEma * 1000).toFixed(1)} µs`;

    const headText =
      HEAD_MAIN +
      line('display', displayText) +
      line('render', `${fpsEma.toFixed(0)} fps`) +
      line('missed', missedText) +
      line('gpu time', gpuText) +
      line('cpu time', cpuText) +
      line('app time', appText) +
      line('app', `${stepsEma.toFixed(0)} steps/s`);

    const late = (stats.appLate - previous.appLate) >>> 0;
    lateTotal += late;
    lateWindows = late > 0 ? lateWindows + 1 : 0;
    const lateText = line('app late', `${(late / seconds).toFixed(0)}/s · ${lateTotal} total`);

    show(headText, lateText.trimEnd(), lateWindows >= LATE_WINDOWS);
  }

  setInterval(sample, SAMPLE_INTERVAL_MS);

  return {
    markReady() {
      renderReady = true;
    },
  };
}
