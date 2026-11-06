// The coach's voice: it plays Coach Milo's own recorded lines from assets/audio/coach/ — generated
// offline with Kokoro-82M (voice am_michael, Apache-2.0) — and keeps the browser's built-in speech
// synthesis as the fallback. No server, no key, no cloud: the page only ever plays finished files.
//
// Every line the workout says is in CLIPS below, mapped from the exact text in workout.js to its MP3.
// A line that is not in the map — or a file that will not load — is spoken by the browser's own
// voice instead, so the workout can never end up silent.

import * as T from 'jam/tuning';

// Where the recorded lines live. Everything the generator writes goes in this one folder.
const CLIP_DIR = 'assets/audio/coach/';

// The workout's lines, exactly as written in workout.js, in the order they are said. If a line in
// workout.js changes and this map is not updated with it, that line falls back to the browser voice
// rather than going quiet — but it should be updated, and the audio regenerated:
//   /tmp/kokoro-venv/bin/python /tmp/kokoro-gen/make_voice.py <model.onnx> <voices.bin> <assets/audio/coach>
const CLIPS = new Map([
  ["Hey there! I'm Coach Milo. I'm here to help you get moving today!", 'greet.mp3'],
  ["Come on, let's get up and get moving. We've got two simple stretches to do together!", 'motivate.mp3'],
  ['First, reach both arms above your head. Stretch up nice and tall!', 'stretch-1.mp3'],
  ["Great job! That's our first stretch done.", 'stretch-1-done.mp3'],
  ["Now, keep your arms up and gently lean to one side. Let's stretch it out!", 'stretch-2.mp3'],
  ["Awesome work! You did both stretches. That's a win for today!", 'cheer.mp3'],
  ["Thanks for working out with me! I'll see you next time!", 'goodbye.mp3'],
]);

// Shown in the ?fps panel, so it is obvious at a glance which voice the page is using.
const VOICE_LABEL = 'am_michael (Kokoro)';

// Fallbacks for the tuning numbers: if tuning.js is missing one or holds a silly value,
// speech.js uses the plain value below instead of handing nonsense to the browser.
const DEFAULT_RATE = 1;
const DEFAULT_PITCH = 1;
const DEFAULT_VOLUME = 1;
const DEFAULT_LANG = 'en';
const DEFAULT_MAX_MS = 15000;
const DEFAULT_MIN_MS = 700;

// Internal plumbing rather than a maker knob: how often we peek at the browser's voice list
// while waiting for it to arrive. There is no number for this in tuning.js.
const VOICE_POLL_MS = 200;

// How long a recording is allowed to run before we stop waiting for it, on top of its own length.
// Generous: a slow phone decoding a small MP3 at the end of a long line is not a failure.
const CLIP_SLACK_MS = 3000;

const ENGLISH = 'en';

// A tuning number counts only if it is a real number inside a sane range; otherwise fall back.
function saneNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (value < min || value > max) return fallback;
  return value;
}

function tuneRate() {
  return saneNumber(T.SPEECH_RATE, 0.1, 10, DEFAULT_RATE);
}

function tunePitch() {
  return saneNumber(T.SPEECH_PITCH, 0, 2, DEFAULT_PITCH);
}

function tuneMaxMs() {
  return saneNumber(T.SPEECH_MAX_MS, 16, 600000, DEFAULT_MAX_MS);
}

function tuneMinMs() {
  return saneNumber(T.SPEECH_MIN_MS, 0, 60000, DEFAULT_MIN_MS);
}

function tuneLang() {
  const lang = T.SPEECH_LANG;
  return typeof lang === 'string' && lang.trim() ? lang.trim() : DEFAULT_LANG;
}

// 'en-GB' and 'en_US' both count as 'en'.
function baseLang(tag) {
  return (typeof tag === 'string' ? tag : '').toLowerCase().split(/[-_]/)[0];
}

// Reading the options object must never throw, even when it is a string or has a wild getter.
function optionValue(options, key) {
  if (!options || typeof options !== 'object') return undefined;
  try {
    return options[key];
  } catch {
    return undefined;
  }
}

function optionLang(options) {
  const lang = optionValue(options, 'lang');
  return typeof lang === 'string' && lang.trim() ? lang.trim() : tuneLang();
}

// A callback the caller supplied must never be able to break a line.
function safeCall(fn) {
  if (typeof fn !== 'function') return;
  try {
    fn();
  } catch {
    /* the callback's problem, not the line's */
  }
}

// The recording for a line of text, as a full URL, or null when this line has no recording.
function clipUrl(line) {
  const file = CLIPS.get(line);
  return file ? CLIP_DIR + file : null;
}

// ONE audio element, reused for every line. This is not an optimisation: it is the fix for the bug
// where only some of the recorded lines were ever heard. A phone lets a media element start only when
// a real tap is behind it, and it counts that per element — so a fresh `new Audio(file)` per line
// means the line played inside the tap that starts the workout is heard, and every line after it,
// played from the workout's own clock with no tap behind it, is refused. One element, unlocked by
// that first tap, plays all seven.
let clipEl = null;
function clipElement() {
  if (clipEl) return clipEl;
  try {
    const el = new Audio();
    el.preload = 'auto';
    el.setAttribute('playsinline', '');
    // In the document rather than floating: some phones will not start a detached element.
    if (document.body) document.body.append(el);
    clipEl = el;
  } catch {
    clipEl = null;
  }
  return clipEl;
}

// The other half of the same complaint: a line that has to wait for its own download arrives late,
// and on a slow phone it can stall half-way through. Loading is not playing, so this needs no tap and
// can be called as soon as there is a quiet moment — main.js does it on the tap that leaves the home
// card, so the time spent reading the next card is spent fetching these seven small files.
const warmedUrls = [];
const warmHold = []; // the loading elements, held so the browser does not drop them mid-download
function warmClips(broken) {
  for (const file of CLIPS.values()) {
    const url = CLIP_DIR + file;
    if (warmedUrls.includes(url) || (broken && broken.has(url))) continue;
    warmedUrls.push(url);
    try {
      const el = new Audio();
      el.preload = 'auto';
      el.src = url;
      el.load();
      warmHold.push(el);
    } catch {
      /* the line still plays; it just fetches when it is asked for */
    }
  }
}

export function createSpeech() {
  let muted = false;
  let current = null; // the one line in flight, or null
  let chosenVoiceName = ''; // the name of the voice we last picked, or ''
  let readyPromise = null;
  // Recordings that failed on this device. A file that will not play is not retried on every line:
  // that line goes to the browser's own voice from then on, but the other recordings still play.
  const brokenClips = new Set();

  // Look the engine up fresh every time: it can be missing, and it can appear late.
  function synth() {
    const engine = globalThis.speechSynthesis;
    return engine && typeof engine.speak === 'function' ? engine : null;
  }

  function utteranceClass() {
    const Ctor = globalThis.SpeechSynthesisUtterance;
    return typeof Ctor === 'function' ? Ctor : null;
  }

  function safeCancel(engine) {
    if (!engine) return;
    try {
      if (typeof engine.cancel === 'function') engine.cancel();
    } catch {
      /* nothing to be done */
    }
  }

  function voiceList(engine) {
    try {
      const list = typeof engine.getVoices === 'function' ? engine.getVoices() : null;
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  // Does the engine say it is busy with something? If it cannot say, assume busy:
  // a wrong "blocked" would cut a line short.
  function engineIsBusy(engine) {
    try {
      const speaking = engine.speaking;
      const pending = engine.pending;
      if (typeof speaking !== 'boolean' && typeof pending !== 'boolean') return true;
      return !!(speaking || pending);
    } catch {
      return true;
    }
  }

  // Chosen fresh on every spoken line, because the voice list often arrives late.
  function pickVoice(engine) {
    const wanted = tuneLang().toLowerCase();
    const wantedBase = baseLang(wanted);
    let best = null;
    let bestTier = 99;

    for (const candidate of voiceList(engine)) {
      if (!candidate) continue;
      const tag = typeof candidate.lang === 'string' ? candidate.lang.toLowerCase() : '';
      const tagBase = baseLang(tag);
      const rightLanguage = tag === wanted || tagBase === wantedBase;
      const local = candidate.localService === true;

      let tier = 99;
      if (local && rightLanguage) tier = 0; // offline voice in the language we want
      else if (local && tagBase === ENGLISH) tier = 1;
      else if (rightLanguage) tier = 2; // online voice in the right language
      else if (tagBase === ENGLISH) tier = 3; // any English voice at all

      if (tier < bestTier) {
        bestTier = tier;
        best = candidate;
        if (tier === 0) break;
      }
    }

    chosenVoiceName = best && typeof best.name === 'string' ? best.name : '';
    return best;
  }

  function makeRecord(resolve, options) {
    return {
      resolve,
      settled: false,
      started: false,
      utterance: null,
      element: null,
      onStart: optionValue(options, 'onStart'),
      onEnd: optionValue(options, 'onEnd'),
      maxTimer: null,
      blockedTimer: null,
      minTimer: null,
    };
  }

  // The single exit door: every line leaves through here exactly once, whatever happened.
  function settle(record, status) {
    if (!record || record.settled) return;
    record.settled = true;

    clearTimeout(record.maxTimer);
    clearTimeout(record.blockedTimer);
    clearTimeout(record.minTimer);
    record.maxTimer = null;
    record.blockedTimer = null;
    record.minTimer = null;

    const utterance = record.utterance;
    if (utterance) {
      try {
        utterance.onstart = null;
        utterance.onend = null;
        utterance.onerror = null;
      } catch {
        /* some engines lock these down */
      }
    }

    // Stop the recording that is playing and let go of the file, so the phone is not holding a
    // decoder open for a line that is over.
    const element = record.element;
    if (element) {
      try {
        element.onplay = null;
        element.onplaying = null;
        element.onended = null;
        element.onerror = null;
        element.onloadedmetadata = null;
        element.onstalled = null;
        element.pause();
        element.removeAttribute('src');
        if (typeof element.load === 'function') element.load();
      } catch {
        /* nothing to be done */
      }
    }

    if (current === record) current = null;
    safeCall(record.onEnd);
    record.resolve(status);
  }

  // Cut off the line in flight and tell its promise the truth about why it stopped.
  function cancelCurrent(status) {
    const record = current;
    if (!record) return;
    settle(record, status); // detach first: a late 'end' event cannot resurrect it
    safeCancel(synth());
  }

  // --- the browser's own voice, used when a line has no recording or its recording will not play ---

  function speakWithBrowser(line, options, resolve) {
    const engine = synth();
    const Ctor = utteranceClass();
    if (!engine || !Ctor) {
      // Nothing can say this line. The caption still shows; the workout is not held up by it.
      resolve('unsupported');
      return;
    }

    // Re-try the voice choice every line: voices load asynchronously in some browsers.
    const voice = pickVoice(engine);

    const record = makeRecord(resolve, options);
    const rate = saneNumber(optionValue(options, 'rate'), 0.1, 10, tuneRate());
    const pitch = saneNumber(optionValue(options, 'pitch'), 0, 2, tunePitch());
    const volume = saneNumber(optionValue(options, 'volume'), 0, 1, DEFAULT_VOLUME);
    const lang = optionLang(options);

    try {
      const utterance = new Ctor(line);
      utterance.text = line;
      utterance.rate = rate;
      utterance.pitch = pitch;
      utterance.volume = volume;
      utterance.lang = lang;
      if (voice) utterance.voice = voice;

      utterance.onstart = () => {
        record.started = true;
        safeCall(record.onStart);
      };
      utterance.onend = () => settle(record, 'spoken');
      utterance.onerror = () => settle(record, 'error');

      record.utterance = utterance;
    } catch {
      resolve('error');
      return;
    }

    current = record;

    // Two safety nets: a line that never reports finishing, and a phone that quietly refuses to start.
    record.maxTimer = setTimeout(() => settle(record, 'timeout'), tuneMaxMs());
    record.blockedTimer = setTimeout(() => {
      if (record.started || record.settled) return;
      if (engineIsBusy(engine)) return; // it took the line, it just has not begun yet
      settle(record, 'blocked');
      safeCancel(engine);
    }, 0);

    try {
      engine.speak(record.utterance);
    } catch {
      // The engine refused the line outright: the same thing as blocked.
      settle(record, 'blocked');
      safeCancel(engine);
    }
  }

  // --- the recorded line, which is what normally plays ---

  function speakWithClip(line, options, resolve) {
    const url = clipUrl(line);
    const element = clipElement();
    if (!element) {
      // No audio at all on this device: the browser's voice is the only way to say it.
      speakWithBrowser(line, options, resolve);
      return;
    }

    const record = makeRecord(resolve, options);
    record.element = element;
    // One settle on the way out: whatever happened, and whichever voice ended up saying it.
    const done = (status) => settle(record, status);

    // The file itself is unreachable — missing, or a format this phone cannot decode. That is worth
    // remembering: this one line goes to the browser's voice from now on, and the other six
    // recordings still play.
    const onDeadFile = () => {
      if (record.settled) return;
      brokenClips.add(url);
      settle(record, 'clipfailed');
      speakWithBrowser(line, options, resolve);
    };

    // The file is fine, but this phone would not start it. That is usually the autoplay rule rather
    // than the file, so it is worth one more try before the browser says the line instead. The
    // recording is deliberately NOT marked broken for this: the next line is a different moment and
    // may well be allowed.
    let tries = 0;
    const refused = () => {
      if (record.settled) return;
      tries += 1;
      if (tries < 2) {
        setTimeout(() => {
          if (record.settled) return;
          let again;
          try { again = element.play(); } catch { refused(); return; }
          if (again && typeof again.catch === 'function') again.catch(refused);
        }, 180);
        return;
      }
      settle(record, 'refused');
      speakWithBrowser(line, options, resolve);
    };

    // A new source on the one element, and its own handlers for this line.
    try {
      element.src = url;
    } catch {
      onDeadFile();
      return;
    }
    element.volume = 1;
    element.onloadedmetadata = () => {
      if (record.settled) return;
      const seconds = Number(element.duration);
      if (Number.isFinite(seconds) && seconds > 0) {
        // Now that the real length is known, the net is set to that length plus a little slack,
        // instead of the flat cap we waited under while the file was still loading.
        clearTimeout(record.maxTimer);
        record.maxTimer = setTimeout(() => done('timeout'), seconds * 1000 + CLIP_SLACK_MS);
      }
    };
    element.onplay = () => {
      record.started = true;
      safeCall(record.onStart);
    };
    element.onended = () => done('spoken');
    element.onerror = onDeadFile;
    // Deliberately NO onstalled handler. A stall means the line is still coming — the browser has
    // simply not got the next chunk yet — and treating it as a failure is how a sentence gets cut off
    // half-way and then repeated in the robot voice. Only a real error is an error.

    current = record;
    // The net for a file that never even reports its length.
    record.maxTimer = setTimeout(() => done('timeout'), tuneMaxMs());

    let started;
    try {
      started = element.play();
    } catch {
      refused();
      return;
    }
    if (started && typeof started.catch === 'function') started.catch(refused);
  }

  function speak(text, options) {
    return new Promise((resolve) => {
      if (muted) {
        // Nothing is said out loud, but a caption still deserves its moment on screen.
        const quiet = makeRecord(resolve, options);
        quiet.minTimer = setTimeout(() => settle(quiet, 'muted'), tuneMinMs());
        return;
      }

      const line = typeof text === 'string' ? text.trim() : '';
      if (!line) {
        // Nothing to say: empty, or not even text. No voice, nothing to wait for.
        resolve('spoken');
        return;
      }

      // Only one line is ever in flight, so an older one is cut off and told so.
      cancelCurrent('cancelled');

      const url = clipUrl(line);
      if (url && !brokenClips.has(url)) speakWithClip(line, options, resolve);
      else speakWithBrowser(line, options, resolve);
    });
  }

  function stop() {
    const record = current;
    if (record) settle(record, 'cancelled');
    safeCancel(synth());
  }

  function setMuted(value) {
    muted = !!value;
    if (!muted) return;
    // Muting must stop the line that is playing at once.
    const record = current;
    if (record) settle(record, 'muted');
    safeCancel(synth());
  }

  // Resolves once the browser has a voice list to choose from, or once waiting is pointless. With
  // recordings in place this is only about the fallback voice, so it never gates the workout.
  function ready() {
    if (readyPromise) return readyPromise;

    readyPromise = new Promise((resolve) => {
      const engine = synth();
      if (!engine) {
        resolve();
        return;
      }

      const startedAt = Date.now();
      const cap = tuneMaxMs(); // never wait longer for voices than we would for a line
      let done = false;
      let poll = null;

      function finish() {
        if (done) return;
        done = true;
        clearTimeout(poll);
        poll = null;
        try {
          if (typeof engine.removeEventListener === 'function') {
            engine.removeEventListener('voiceschanged', onVoices);
          }
        } catch {
          /* nothing to be done */
        }
        pickVoice(engine);
        resolve();
      }

      function onVoices() {
        if (voiceList(engine).length > 0) finish();
      }

      function tick() {
        if (done) return;
        if (voiceList(engine).length > 0 || Date.now() - startedAt >= cap) {
          finish();
          return;
        }
        poll = setTimeout(tick, VOICE_POLL_MS);
      }

      if (voiceList(engine).length > 0) {
        finish();
        return;
      }

      try {
        if (typeof engine.addEventListener === 'function') {
          engine.addEventListener('voiceschanged', onVoices);
        }
      } catch {
        /* if the engine will not talk to us, the poll below still works */
      }
      poll = setTimeout(tick, VOICE_POLL_MS);
    });

    return readyPromise;
  }

  return {
    get supported() {
      // The recordings are the voice now; the browser's engine is only the fallback.
      return CLIPS.size > 0 || !!(synth() && utteranceClass());
    },
    get muted() {
      return muted;
    },
    get voice() {
      // Which voice is actually saying the lines, for the ?fps panel.
      return CLIPS.size > 0 ? VOICE_LABEL : chosenVoiceName;
    },
    get clips() {
      return CLIPS.size;
    },
    // Fetch the recordings ahead of time. Called from the tap that leaves the home card.
    warm() { warmClips(brokenClips); },
    setMuted,
    speak,
    stop,
    ready,
  };
}
