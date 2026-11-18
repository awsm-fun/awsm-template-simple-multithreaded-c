// stats.js — the stats panel (top right) and the Stats button (bottom left)
// that shows and hides it.
//
// One group per thread, so that every number sits under the thread that
// spent it, and every number says its unit and what it is per:
//
//   display                    the display's refresh rate (measured here, from
//                              this thread's own animation frames), the frames
//                              the renderer presented per second, and the
//                              refreshes that went by without a new frame.
//   GPU                        the GPU's time per frame, from the renderer's
//                              timestamp queries (`n/a` without them). Its
//                              rows are the passes; on GPUs that run passes
//                              overlapped (Apple's) they add up to more than
//                              the frame.
//   renderer (render worker)   the render worker's CPU time per frame.
//   app (C, app worker)        the app's CPU time per fixed step, its steps
//                              per second, and the frames the renderer drew
//                              before the app had published the moment they
//                              show ("late": bridge.h, "Frame pacing").
//   page (main thread)         this thread's own work per frame.
//
// A group's header always shows its headline number. Expanding a group shows
// its breakdown, and only then is the breakdown measured: the page sets a bit
// in the bridge block (`detail`), and the app and the renderer time their
// phases and passes only while it is set. A collapsed panel costs nothing.
//
// Once a second the panel samples the running totals the app and the renderer
// keep in the bridge block (bridge_stats and the timing table in
// app/src/bridge.h): no messages. Every figure is the change in a total
// divided by the change in what it is per (frames, steps, or REAL seconds:
// a one-second timer is not exactly a second apart, and is throttled in a
// background tab), then smoothed.

import { DETAIL, TIMING } from './bridge.js';
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
// The late-frames line turns red when the app was late in this many sample
// windows in a row: a steady condition, not a one-off such as a tab switch.
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

// The groups, top to bottom. `detail`: the bit that asks the other threads to
// measure this group's breakdown while it is expanded.
const GROUPS = [
  { id: 'display', label: 'display' },
  { id: 'gpu', label: 'GPU', detail: DETAIL.GPU },
  { id: 'renderer', label: 'renderer (render worker)', detail: DETAIL.RENDERER },
  { id: 'app', label: 'app (C, app worker)', detail: DETAIL.APP },
  { id: 'page', label: 'page (main thread)' },
];

// The renderer's phase whose time its per-pass rows are a breakdown of.
const RENDER_PHASE = 'render (encode + submit)';

// A duration with its unit: microseconds below a tenth of a millisecond.
function duration(ms) {
  if (ms < 0.09995) {
    const us = ms * 1000;
    return `${us < 9.95 ? us.toFixed(1) : us.toFixed(0)} µs`;
  }
  return `${ms < 9.995 ? ms.toFixed(2) : ms.toFixed(1)} ms`;
}

const smooth = (ema, value) => (ema == null ? value : ema + (value - ema) * EMA_ALPHA);

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

// Builds the panel's elements: per group, a header button (label left,
// headline right) and the rows it shows while expanded. Returns
// { set(id, headline, rows, bad), detail(), onToggle }.
function buildGroups(panel) {
  const parts = new Map();
  const view = { onToggle: () => {} };
  for (const group of GROUPS) {
    const key = `${STATS_STORAGE_KEY}_open_${group.id}`;
    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'stats-group';
    const label = document.createElement('span');
    const headline = document.createElement('span');
    header.append(label, headline);
    const rows = document.createElement('div');
    rows.className = 'stats-rows';
    rows.id = `stats-rows-${group.id}`;
    header.setAttribute('aria-controls', rows.id);

    const part = { group, open: false, header, headline, rows };
    const setOpen = (open) => {
      part.open = open;
      rows.hidden = !open;
      header.setAttribute('aria-expanded', String(open));
      label.textContent = `${open ? '▾' : '▸'} ${group.label}`;
    };
    setOpen(storedBool(key) === true); // collapsed unless the user opened it
    header.addEventListener('click', () => {
      setOpen(!part.open);
      storeBool(key, part.open);
      view.onToggle();
    });
    parts.set(group.id, part);
    panel.append(header, rows);
  }

  // `rows`: [label, value] pairs; a third `true` indents a row one level
  // (a breakdown of the row above), and a fourth marks it bad (red).
  view.set = (id, headline, rows = [], bad = false) => {
    const part = parts.get(id);
    part.headline.textContent = headline;
    part.header.classList.toggle('stats-bad', bad);
    if (!part.open) return;
    part.rows.replaceChildren(
      ...rows.map(([label, value, nested, rowBad]) => {
        const row = document.createElement('div');
        row.className = `stats-row${nested ? ' stats-nested' : ''}${rowBad ? ' stats-bad' : ''}`;
        const name = document.createElement('span');
        name.textContent = label;
        const figure = document.createElement('span');
        figure.textContent = value;
        row.append(name, figure);
        return row;
      }),
    );
  };
  // The DETAIL bits of the groups that are expanded.
  view.detail = () => {
    let bits = 0;
    for (const part of parts.values()) if (part.open) bits |= part.group.detail ?? 0;
    return bits;
  };
  return view;
}

// `getBridge()` returns the current app's Bridge (or null while there is
// none). Returns { markReady(), pageFrame(ms) }: call the first when the
// renderer reports `ready`, the second once per animation frame with the time
// this thread spent on it.
export function installStats({ getBridge }) {
  const panel = document.getElementById('stats');
  const button = document.getElementById('stats-btn');
  const view = buildGroups(panel);

  const refresh = measureRefresh();
  let renderReady = false;
  let bridge = null; // the Bridge the state below belongs to
  let baseline = null; // the previous sample
  let fpsEma = null;
  let stepsEma = null;
  let frameWorkEma = null;
  let stepWorkEma = null;
  let gpuEma = null;
  let pageEma = null;
  // Trusted windows in a row without a single GPU sample: after a few, the
  // device evidently has no timestamp queries, and the group says so.
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
  // The timing table: each entry's previous reading and its smoothed mean,
  // by entry.
  let timingBaseline = new Map();
  const timingMeans = new Map();
  // This thread's own work, summed between samples.
  let pageMs = 0;
  let pageFrames = 0;

  // The breakdowns are only measured while the panel shows them: tell the
  // other threads which groups are expanded (none while the panel is hidden).
  const publishDetail = () => getBridge()?.setDetail(panel.hidden ? 0 : view.detail());
  view.onToggle = () => {
    publishDetail();
    render(); // the rows of a group just opened fill in on the next sample
  };

  // Off by default: on a phone the panel covers a lot of the screen. A stored
  // "open" is only honoured on a desktop; on a touch device the button still
  // opens it for the session.
  const setOpen = (open) => {
    panel.hidden = !open;
    button.classList.toggle('active', open);
    publishDetail();
  };
  setOpen(!coarsePointer() && storedBool(STATS_STORAGE_KEY) === true);
  button.addEventListener('click', () => {
    const open = panel.hidden;
    setOpen(open);
    storeBool(STATS_STORAGE_KEY, open);
  });

  // A hidden tab runs no frames: never turn that gap into a rate.
  document.addEventListener('visibilitychange', () => {
    baseline = null;
  });

  // What the panel shows until there are numbers.
  let placeholder = 'starting…';
  let late = { rate: 0, bad: false };

  // The timing-table rows of one kind: [name, mean in ms], in table order.
  const timings = (kind) =>
    [...timingMeans.values()].filter((entry) => entry.kind === kind && entry.ms != null);
  const slowestFirst = (entries) => entries.sort((a, b) => b.ms - a.ms);

  function render() {
    if (placeholder) {
      for (const group of GROUPS) view.set(group.id, group.id === 'display' ? '—' : placeholder);
      return;
    }
    const periodMs = refresh.periodMs();
    const hz = periodMs === null ? null : `${(1000 / periodMs).toFixed(0)} Hz`;
    const fps = `${fpsEma.toFixed(0)}`;
    view.set('display', `${hz ?? 'measuring…'} · ${fps} fps`, [
      ['refresh rate', hz ?? 'measuring…'],
      ['frames presented', `${fps} / s`],
      [
        'missed frames',
        missedRate === null ? '—' : `${missedRate.toFixed(0)} / s · ${Math.max(missedTotal, 0)} total`,
      ],
    ]);

    let gpu = '—';
    if (gpuEma !== null) gpu = `${duration(gpuEma)} / frame`;
    else if (gpuEmptyWindows >= 3) gpu = 'n/a';
    view.set(
      'gpu',
      gpu,
      slowestFirst(timings(TIMING.GPU_PASS)).map((pass) => [pass.name, `${duration(pass.ms)} / frame`]),
    );

    // The renderer's phases in the order they run, with its CPU time inside
    // each pass listed under the phase that encodes them.
    const rendererRows = [];
    const passes = slowestFirst(timings(TIMING.RENDERER_PASS));
    for (const phase of timings(TIMING.RENDERER_PHASE)) {
      rendererRows.push([phase.name, `${duration(phase.ms)} / frame`]);
      if (phase.name !== RENDER_PHASE || passes.length === 0) continue;
      for (const pass of passes) rendererRows.push([pass.name, `${duration(pass.ms)} / frame`, true]);
      // What render() spends that no pass accounts for: per-frame uploads,
      // culling, bookkeeping.
      const inPasses = passes.reduce((sum, pass) => sum + pass.ms, 0);
      rendererRows.push([
        'outside the passes',
        `${duration(Math.max(phase.ms - inPasses, 0))} / frame`,
        true,
      ]);
    }
    // The renderer's per-pass timers are costly, so it runs them on some
    // frames only and reports what they add to the average frame: the one
    // part of the headline that is there because the group is open.
    for (const overhead of timings(TIMING.RENDERER_OVERHEAD)) {
      rendererRows.push([`${overhead.name} (only while open)`, `${duration(overhead.ms)} / frame`]);
    }
    view.set(
      'renderer',
      frameWorkEma === null ? '—' : `${duration(frameWorkEma)} / frame`,
      rendererRows,
    );

    view.set(
      'app',
      stepWorkEma === null ? '—' : `${duration(stepWorkEma)} / step`,
      [
        ['steps', `${stepsEma.toFixed(0)} steps/s`],
        ['late frames', `${late.rate.toFixed(0)} / s · ${lateTotal} total`, false, late.bad],
        ...timings(TIMING.APP_PHASE).map((phase) => [phase.name, `${duration(phase.ms)} / step`]),
      ],
      late.bad,
    );

    // All this thread does per frame is in main.js's frame(): one row.
    const page = pageEma === null ? '—' : `${duration(pageEma)} / frame`;
    view.set('page', page, [['app events + HUD', page]]);
  }

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
      timingBaseline = new Map();
      timingMeans.clear();
      publishDetail(); // the new block has not been told yet
    }
    if (!bridge) {
      placeholder = 'starting…';
      render();
      return;
    }

    const stats = bridge.readStats();
    const previous = baseline;
    baseline = { at: now, ...stats };
    const previousTimings = timingBaseline;
    timingBaseline = new Map(bridge.readTimings().map((entry) => [entry.slot, entry]));
    const page = { ms: pageMs, frames: pageFrames };
    pageMs = 0;
    pageFrames = 0;

    // Nothing is counted until the renderer is drawing for real, and then
    // only after WARMUP_FRAMES more frames. The baseline above keeps moving,
    // so the first window shown starts exactly where the warm-up ends.
    if (!renderReady) return; // still "starting…"
    warmFrame ??= stats.frameCount;
    if (((stats.frameCount - warmFrame) >>> 0) < WARMUP_FRAMES) {
      placeholder = 'warming up…';
      render();
      return;
    }
    // No trustworthy window (the first sample, or a jittered or throttled
    // gap): the baseline has been reset above; keep the last figures up.
    if (!previous || !(now - previous.at >= MIN_WINDOW_MS && now - previous.at < MAX_WINDOW_MS)) {
      return;
    }
    placeholder = null;
    const seconds = (now - previous.at) / 1000;

    const frames = (stats.frameCount - previous.frameCount) >>> 0;
    const steps = (stats.latestStep - previous.latestStep) >>> 0;
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
    if (page.frames > 0) pageEma = smooth(pageEma, page.ms / page.frames);
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

    const lateFrames = (stats.appLate - previous.appLate) >>> 0;
    lateTotal += lateFrames;
    lateWindows = lateFrames > 0 ? lateWindows + 1 : 0;
    late = { rate: lateFrames / seconds, bad: lateWindows >= LATE_WINDOWS };

    // The breakdowns: each entry's mean over the window. An entry that did
    // not advance is no longer being measured (its group was collapsed, or
    // the pass did not run), so it drops out rather than show a stale figure.
    for (const [slot, entry] of timingBaseline) {
      const before = previousTimings.get(slot);
      const count = before ? (entry.count - before.count) >>> 0 : 0;
      if (count === 0) {
        timingMeans.delete(slot);
        continue;
      }
      const ms = ((entry.totalNs - before.totalNs) >>> 0) / count / 1e6;
      const mean = timingMeans.get(slot);
      timingMeans.set(slot, { kind: entry.kind, name: entry.name, ms: smooth(mean?.ms, ms) });
    }

    render();
  }

  render();
  setInterval(sample, SAMPLE_INTERVAL_MS);

  return {
    markReady() {
      renderReady = true;
    },
    pageFrame(ms) {
      pageMs += ms;
      pageFrames += 1;
    },
  };
}
