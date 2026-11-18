// RUNTIME: shared by every game; your game goes in app/src/game/ and dom/game.js
//
// about.js — the About button (bottom centre) and its modal, which has two
// tabs: About, and Stats (what the Stats panel's numbers mean). The text is in
// index.html.

import { modal } from './modal.js';

// Returns { open(tab) }: `tab` is 'about' (the default) or 'stats'.
export function installAbout() {
  const overlay = document.getElementById('about');
  const about = modal(overlay);
  const tabs = [...overlay.querySelectorAll('[role="tab"]')];

  // One tab is selected: its panel shows, and it alone is in the Tab order
  // (the arrow keys move between tabs, as the tabs pattern has it).
  const select = (tab) => {
    for (const other of tabs) {
      const selected = other === tab;
      other.setAttribute('aria-selected', String(selected));
      other.tabIndex = selected ? 0 : -1;
      document.getElementById(other.getAttribute('aria-controls')).hidden = !selected;
    }
  };
  for (const tab of tabs) tab.addEventListener('click', () => select(tab));
  overlay.querySelector('[role="tablist"]').addEventListener('keydown', (event) => {
    const current = tabs.indexOf(document.activeElement);
    const next = {
      ArrowRight: (current + 1) % tabs.length,
      ArrowLeft: (current - 1 + tabs.length) % tabs.length,
      Home: 0,
      End: tabs.length - 1,
    }[event.key];
    if (current < 0 || next === undefined) return;
    event.preventDefault();
    select(tabs[next]);
    tabs[next].focus();
  });

  const open = (name = 'about') => {
    const tab = tabs.find((tab) => tab.id === `about-tab-${name}`) ?? tabs[0];
    select(tab);
    about.open();
    tab.focus(); // so that the keyboard is in the modal, not on the page behind
  };
  document.getElementById('about-btn').addEventListener('click', () => open());
  return { open };
}
