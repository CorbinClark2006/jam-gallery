// ui.js — every piece of the screen the player reads or taps: the start card, the running workout's
// buttons, the countdown, the captions, and the finish card. Nothing here knows about 3D.

// Every element this module touches, looked up once at construction. A missing element would be a
// broken index.html, so each one is checked and the module degrades to a no-op rather than throwing
// a wall of null errors into the console.
const IDS = [
  'home', 'btn-play',
  'start', 'start-note', 'btn-start', 'btn-preview',
  'hud', 'step-title', 'btn-mute', 'btn-replace', 'btn-quit', 'btn-skip', 'btn-action',
  'count', 'caption', 'hint',
  'done', 'done-title', 'done-line', 'summary', 'btn-again', 'btn-restart',
];

export function createUi(handlers) {
  const el = Object.create(null);
  for (const id of IDS) el[id] = document.getElementById(id);
  const missing = IDS.filter((id) => !el[id]);
  if (missing.length) console.warn('ui.js: missing elements in index.html:', missing.join(', '));

  const h = handlers || {};
  const on = (node, event, fn) => {
    if (node && typeof fn === 'function') node.addEventListener(event, fn);
  };

  on(el['btn-play'], 'click', () => h.onPlay && h.onPlay());
  on(el['btn-start'], 'click', () => h.onCamera && h.onCamera());
  on(el['btn-preview'], 'click', () => h.onPreview && h.onPreview());
  on(el['btn-action'], 'click', () => h.onAction && h.onAction());
  on(el['btn-mute'], 'click', () => h.onMute && h.onMute());
  on(el['btn-replace'], 'click', () => h.onReplace && h.onReplace());
  on(el['btn-quit'], 'click', () => h.onQuit && h.onQuit());
  on(el['btn-skip'], 'click', () => h.onSkip && h.onSkip());
  on(el['btn-again'], 'click', () => h.onAgain && h.onAgain());
  on(el['btn-restart'], 'click', () => h.onRestart && h.onRestart());

  const show = (node, visible) => { if (node) node.hidden = !visible; };
  const text = (node, value) => { if (node) node.textContent = value; };

  // Re-runs a one-shot animation: take the class off, make the browser notice it is gone, put it
  // back. That read of offsetWidth is the forcing — without it the browser batches both changes
  // into one style recalculation, sees the class in the same state as before, and never restarts
  // the animation. The class names are index.html's: .pop for a button, .count-pop for the number.
  const replay = (node, cls) => {
    if (!node) return;
    node.classList.remove(cls);
    void node.offsetWidth;
    node.classList.add(cls);
  };

  // Press feedback for every button on the page, wired in one place rather than one listener per
  // button: a new button in index.html then gets the pop for free.
  for (const node of Object.values(el)) {
    if (node && node.tagName === 'BUTTON') on(node, 'click', () => replay(node, 'pop'));
  }

  // The last number the countdown actually rendered. setCountdown() is called every frame with the
  // same value, and an animation restarted every frame never plays, so the pop is keyed to changes.
  let lastCount = null;

  const ui = {
    // The home card: the name, and Play. The coach waves behind it from page load.
    showHome(visible) { show(el.home, visible); },
    // The start card. `note` is the line under the heading.
    showStart(visible, note) { show(el.start, visible); if (note) text(el['start-note'], note); },
    // The running workout's furniture.
    showHud(visible) { show(el.hud, visible); },
    showDone(visible) { show(el.done, visible); },

    // Which stretch we are on. Also used by the workout's own step titles.
    setTitle(title) { text(el['step-title'], title || ''); },

    // The countdown. `seconds` of null hides it entirely — never a stale number left on screen.
    // A number that is the same as last time is left alone; a new number lands with a pop.
    setCountdown(seconds) {
      if (seconds === null || seconds === undefined) {
        lastCount = null; // so the next number animates, even if it is the one we just hid
        show(el.count, false);
        return;
      }
      const value = String(seconds);
      if (value !== lastCount) { lastCount = value; text(el.count, value); replay(el.count, 'count-pop'); }
      show(el.count, true);
    },

    // The spoken line, as text. Empty or missing hides the caption.
    setCaption(line) {
      const clean = typeof line === 'string' ? line.trim() : '';
      text(el.caption, clean);
      show(el.caption, clean.length > 0);
    },

    // The one big button at the bottom: it means different things at different moments.
    // Showing or hiding it needs no help from here any more. index.html stacks the caption and the
    // button in one flex column, so the caption sits above the button whether the button is there
    // or not — which is what this used to fake by moving the caption with a class.
    setAction(label, visible) {
      if (label) text(el['btn-action'], label);
      show(el['btn-action'], visible !== false && !!label);
      if (el['btn-action']) el['btn-action'].disabled = false;
    },
    setActionEnabled(enabled) { if (el['btn-action']) el['btn-action'].disabled = !enabled; },

    setMuted(muted) {
      text(el['btn-mute'], muted ? 'Sound off' : 'Sound on');
      if (el['btn-mute']) el['btn-mute'].setAttribute('aria-pressed', muted ? 'true' : 'false');
    },

    // One plain-English line about a camera or sensor problem. Errors are never sticky: the next
    // successful step clears them.
    hint(message) {
      const clean = typeof message === 'string' ? message.trim() : '';
      text(el.hint, clean);
      show(el.hint, clean.length > 0);
    },
    clearHint() { show(el.hint, false); },

    // The finish card. `lines` is an array of strings, one per ticked-off item.
    showSummary(title, lines, line) {
      text(el['done-title'], title || 'Workout complete');
      if (el.summary) {
        el.summary.replaceChildren();
        for (const item of (Array.isArray(lines) ? lines : [])) {
          const li = document.createElement('li');
          const ok = typeof item === 'string' && item.startsWith('✓');
          li.textContent = typeof item === 'string' ? item : String(item);
          if (ok) li.style.color = '#8fe3a8';
          el.summary.append(li);
        }
      }
      text(el['done-line'], line || '');
    },

    // Everything off, for a clean restart.
    reset() {
      ui.showDone(false);
      ui.showHud(false);
      ui.setCaption('');
      ui.setCountdown(null);
      ui.setAction('Start workout', false);
    },
    get missingElements() { return missing.slice(); },
  };

  return ui;
}
