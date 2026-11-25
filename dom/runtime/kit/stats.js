// awsm-renderer-kit v0.1.2: js/stats.js, copied by the kit's scripts/sync-js.sh.
// Do not edit this copy: change the kit, then sync again.
//
// stats.js — the stats panel and the button that shows and hides it: the JS
// twin of the awsm-renderer-stats crate's `StatsPanel`, for pages without
// Rust.
//
// A dumb view. The worker that runs the renderer measures, windows, smooths
// and formats everything (the crate's StatsCollector) and posts a report
// about once a second (`stats`); this module shows it, generically: one
// header per group (label, headline) and its rows while expanded. What it
// sends back:
//
//   stats-view   whether the panel is shown and which groups are expanded,
//                on every change. Only those are measured, so a collapsed
//                panel costs nothing.
//   stats-page   once a second, what only the page sees: the gaps between
//                its own animation frames (the display's refresh rate; the
//                page does little per frame, so it lands on every refresh
//                even when the renderer does not) and its own work per frame.
//
// Stored under the app's prefix: `stats` (the panel shown, "1"/"0"; off by
// default, and a stored "open" is only honoured on a desktop) and
// `stats_open_<group>` (expanded groups; collapsed by default).

import { coarsePointer, el, setShown, storeBool, storedBool } from './kit-web.js';

// The worker → page message types this module handles.
export const STATS_TYPES = ['stats'];

// How often the page sends what it measured (ms).
const SAMPLE_INTERVAL_MS = 1000;
// A lane's share of the frame budget from which its bar warns.
const SHARE_WARN = 0.8;

// A lane's dot.
function dot(lane) {
  const element = el('span', 'stats-dot');
  element.dataset.lane = lane;
  return element;
}

// Fills `element` with a value as it is shown: the numbers bright, and the
// units and words around them smaller and dimmer.
function showValue(element, text) {
  element.replaceChildren(
    ...String(text)
      .split(/(<?\d[\d.]*%?)/)
      .filter((piece) => piece !== '')
      .map((piece) => el('span', /^<?\d/.test(piece) ? 'stats-num' : 'stats-unit', piece)),
  );
}

function rowElement({ label, value, depth = 0, bad = false, lane = null, share = null }) {
  const row = el('div');
  const nested = ['', ' stats-nested', ' stats-nested stats-nested-2'][Math.min(Number(depth) || 0, 2)];
  row.className = `stats-row${nested}${bad ? ' stats-bad' : ''}`;
  const name = el('span', 'stats-name');
  name.append(...(lane ? [dot(lane)] : []), label);
  const figure = el('span', 'stats-value');
  showValue(figure, value);
  if (lane && share != null) {
    // The share as a bar too; its colour says how close to the budget.
    const state = share > 1 ? ' stats-over' : share >= SHARE_WARN ? ' stats-warn' : '';
    const bar = el('span', `stats-bar${state}`);
    const fill = el('span');
    fill.style.width = `${Math.min(share, 1) * 100}%`;
    bar.append(fill);
    figure.prepend(bar);
  }
  row.append(name, figure);
  return row;
}

// Installs the panel.
//
//   prefix       the app's storage prefix
//   panel        the element the groups go in (hidden while the panel is)
//   button       the element that shows and hides it (gets `.active`), or null
//   post(msg)    sends a message to the worker
//   onHelp       opens an explanation of the panel ("what do these mean?"),
//                or null for no such button
//   pagePart     the name of the page's work in the page group
//   appSections  (report) => [section]: groups only the page knows, shown
//                after the worker's app sections (they do not join the budget)
//   sectionRows  (groupId, report) => [row]: rows only the page knows, added
//                to the end of a group the worker sent (game rows, "last
//                cue"); called for expanded groups only. A row is
//                { label, value, depth?, bad? }
//   shown        the panel's initial state; default: the stored choice,
//                never on a touch device
//
// Returns { handleMessage(msg) → bool, pageFrame(ms, part?), setOpen(open),
// isOpen(), lastReport() }: call pageFrame once per animation frame with the
// time the page spent on it.
export function installStats({
  prefix,
  panel,
  button = null,
  post,
  onHelp = null,
  pagePart = 'page',
  appSections = () => [],
  sectionRows = null,
  shown = null,
}) {
  const storageKey = `${prefix}stats`;
  if (onHelp) {
    const help = el('button', 'stats-help', 'what do these mean?');
    help.type = 'button';
    help.addEventListener('click', onHelp);
    panel.append(help);
  }

  // The groups, by id, in the order of the latest report.
  const parts = new Map();
  let order = [];
  let report = null;

  const openIds = () => [...parts.values()].filter((part) => part.open).map((part) => part.id);
  const isOpen = () => !panel.hidden;
  const publishView = () => post({ type: 'stats-view', shown: isOpen(), open: openIds() });

  function part(group) {
    let existing = parts.get(group.id);
    if (existing) return existing;
    const key = `${prefix}stats_open_${group.id}`;
    const header = el('button', 'stats-group');
    header.type = 'button';
    const label = el('span', 'stats-name');
    const arrow = el('span');
    const headline = el('span', 'stats-value');
    header.append(label, ' ', headline); // the space is for a screen reader
    const rows = el('div', 'stats-rows');
    rows.id = `stats-rows-${group.id}`;
    header.setAttribute('aria-controls', rows.id);
    existing = { id: group.id, open: false, header, label, arrow, headline, rows, look: null };
    const setOpen = (open) => {
      existing.open = open;
      setShown(rows, open);
      header.setAttribute('aria-expanded', String(open));
      arrow.textContent = open ? '▾ ' : '▸ ';
    };
    setOpen(storedBool(key) === true); // collapsed unless the user opened it
    header.addEventListener('click', () => {
      setOpen(!existing.open);
      storeBool(key, existing.open);
      publishView();
      // The rows of a group just opened fill in with the next report.
      if (report) render(report);
    });
    parts.set(group.id, existing);
    return existing;
  }

  function show(group) {
    const view = part(group);
    // The header's label: arrow, lane dot, words (rebuilt only on a change).
    const lane = group.lane ?? null;
    const look = `${lane}\n${group.label}`;
    if (view.look !== look) {
      view.look = look;
      view.label.replaceChildren(view.arrow, ...(lane ? [dot(lane)] : []), group.label);
    }
    showValue(view.headline, group.headline);
    view.header.classList.toggle('stats-bad', Boolean(group.bad));
    if (view.open) {
      const extra = sectionRows?.(group.id, report) ?? [];
      view.rows.replaceChildren(...[...(group.rows ?? []), ...extra].map(rowElement));
    }
    return view;
  }

  function render(next) {
    report = next;
    // Hidden: nothing to draw (the report still arrives each second, for
    // lastReport()); it is drawn when the panel shows.
    if (!isOpen()) return;
    const groups = [
      next.budget,
      next.display,
      next.gpu,
      next.renderer,
      ...(next.app ?? []),
      ...appSections(next),
      next.page,
    ].filter(Boolean);
    const known = parts.size;
    const views = groups.map(show);
    const ids = views.map((view) => view.id);
    // Only re-append when the order changed: moving a focused header would
    // take the focus away.
    if (ids.join('\n') !== order.join('\n')) {
      order = ids;
      for (const view of views) panel.append(view.header, view.rows);
      for (const [id, view] of parts) {
        if (!ids.includes(id)) {
          view.header.remove();
          view.rows.remove();
        }
      }
    }
    // New groups bring their stored open state: tell the worker.
    if (parts.size !== known) publishView();
  }

  // Off by default: on a phone the panel covers a lot of the screen. A
  // stored "open" is only honoured on a desktop; on a touch device the
  // button still opens it for the session.
  const setOpen = (open) => {
    setShown(panel, open);
    button?.classList.toggle('active', open);
    publishView();
    if (open && report) render(report);
  };
  setOpen(shown ?? (!coarsePointer() && storedBool(storageKey) === true));
  button?.addEventListener('click', () => {
    const open = !isOpen();
    setOpen(open);
    storeBool(storageKey, open);
  });

  // The page's own animation frames: their gaps are the display's refresh.
  let gaps = [];
  let last = null;
  const tick = (t) => {
    if (last !== null) gaps.push(t - last);
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  // A hidden tab runs no frames: the gap across it is not a refresh.
  document.addEventListener('visibilitychange', () => {
    last = null;
  });

  // The page's own work, summed between samples, by part.
  let page = new Map();
  let pageFrames = 0;
  setInterval(() => {
    post({
      type: 'stats-page',
      gaps,
      page: [...page].map(([name, ms]) => ({ name, ms })),
      frames: pageFrames,
    });
    gaps = [];
    page = new Map();
    pageFrames = 0;
  }, SAMPLE_INTERVAL_MS);

  return {
    handleMessage(msg) {
      if (msg?.type !== 'stats') return false;
      render(msg);
      return true;
    },
    // Once per animation frame: the time the page spent on it (ms), under
    // `part` (default: `pagePart`). Several parts per frame: count the frame
    // once, with the others under `{ frame: false }`.
    pageFrame(ms, part = pagePart, { frame = true } = {}) {
      page.set(part, (page.get(part) ?? 0) + ms);
      if (frame) pageFrames += 1;
    },
    // Shows or hides the panel and stores the choice.
    setOpen(open) {
      setOpen(open);
      storeBool(storageKey, open);
    },
    isOpen,
    // The latest report (its `summary` holds the raw figures: refreshMs,
    // fps, cpuMs, gpuMs, pageMs, frameInterval).
    lastReport: () => report,
  };
}
