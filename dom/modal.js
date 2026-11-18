// modal.js — the behaviour every overlay on the page shares.

// Wires up the overlay element `overlay` (one of the `…-overlay` elements in
// index.html) and returns { open(), close() }. A dismissable overlay closes
// on any of its [data-close] buttons, on a click on the backdrop itself (not
// on the card in it), and on Escape. One that is not dismissable is only
// closed by the code that opened it.
export function modal(overlay, { dismissable = true } = {}) {
  // The page sends keys to the app from a window listener that also stops
  // their default action (no scrolling on Space or the arrows). A key pressed
  // on a control in here stays with that control instead, so the arrows move
  // a slider or a select, and Space presses a button. Escape still goes
  // through, so the overlay closes.
  overlay.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' && event.target.matches('input, select, button')) {
      event.stopPropagation();
    }
  });
  const open = () => {
    overlay.hidden = false;
  };
  const close = () => {
    overlay.hidden = true;
  };
  if (dismissable) {
    for (const button of overlay.querySelectorAll('[data-close]')) {
      button.addEventListener('click', close);
    }
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close();
    });
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !overlay.hidden) close();
    });
  }
  return { open, close };
}
