// The workout's clock and step machine: it decides which line Coach Milo says next, how long each stretch is held, and when the workout is over. It knows nothing about 3D, sound or the page.

import * as T from 'jam/tuning';

// --- Numbers, guarded -------------------------------------------------------
// Every number below is copied from tuning.js if it is a sane number, and
// otherwise replaced with the value written above it. A maker typing a string,
// a NaN or a negative into tuning.js can never break the workout.
const FALLBACK = { overheadHold: 10, sideHold: 10, sideSwap: 5, stepMax: 14, gap: 0.4 };

function sane(value, fallback, allowZero) {
  const ok = typeof value === 'number' && Number.isFinite(value) && (allowZero ? value >= 0 : value > 0);
  return ok ? value : fallback;
}

const OVERHEAD_HOLD = sane(T.WORKOUT_OVERHEAD_HOLD, FALLBACK.overheadHold, false);
const SIDE_HOLD = sane(T.WORKOUT_SIDE_HOLD, FALLBACK.sideHold, false);
const SIDE_SWAP = sane(T.WORKOUT_SIDE_SWAP, FALLBACK.sideSwap, false);
const STEP_MAX = sane(T.WORKOUT_STEP_MAX, FALLBACK.stepMax, false);
const GAP = sane(T.WORKOUT_GAP, FALLBACK.gap, true); // 0 is allowed: a gap of zero is still legal

const EPS = 1e-9;
const POSES = ['wave', 'talking', 'standUp', 'overhead', 'side', 'cheer', 'idle'];

// The six steps, in the order they happen. `max` is the hard cap: a step can
// never outlive it, so the workout can never deadlock when the voice (or the
// whole speech layer) never reports back.
function makeSteps() {
  const raw = [
    {
      id: 'greet', title: 'Welcome', pose: 'wave', hold: 0, after: null,
      say: "Hey there! I'm Coach Milo. I'm here to help you get moving today!",
    },
    {
      id: 'motivate', title: "Let's move", pose: 'standUp', hold: 0, after: null,
      say: "Come on, let's get up and get moving. We've got two simple stretches to do together!",
    },
    {
      id: 'overhead', title: 'Stretch 1: Overhead', pose: 'overhead', hold: OVERHEAD_HOLD,
      after: "Great job! That's our first stretch done.",
      say: 'First, reach both arms above your head. Stretch up nice and tall!',
    },
    {
      id: 'side', title: 'Stretch 2: Side', pose: 'side', hold: SIDE_HOLD, after: null,
      say: "Now, keep your arms up and gently lean to one side. Let's stretch it out!",
    },
    {
      id: 'cheer', title: 'Well done', pose: 'cheer', hold: 0, after: null,
      say: "Awesome work! You did both stretches. That's a win for today!",
    },
    {
      id: 'end', title: 'Finished', pose: 'idle', hold: 0, after: null,
      say: "Thanks for working out with me! I'll see you next time!",
    },
  ];
  // A hold step's cap is its hold PLUS the step cap, so the countdown is never
  // cut short; a hold step's cap for everything before the hold is the step cap.
  return raw.map((s) => ({
    id: s.id,
    title: s.title,
    say: s.say,
    pose: POSES.includes(s.pose) ? s.pose : 'talking',
    hold: s.hold,
    after: s.after,
    max: s.hold > 0 ? s.hold + STEP_MAX : STEP_MAX,
  }));
}

const countMax = (step) => Math.max(1, Math.ceil(step.hold));

export function createWorkout(hooks) {
  const h = hooks && typeof hooks === 'object' ? hooks : {};
  // A hook that throws, or is not a function, must never break the workout.
  function call(name, a, b) {
    const fn = h[name];
    if (typeof fn !== 'function') return;
    try { fn(a, b); } catch (err) { /* a broken callback is ignored */ }
  }

  const steps = makeSteps();
  const SIDE_INDEX = steps.findIndex((s) => s.id === 'side');
  const STRETCH_COUNT = steps.filter((s) => s.hold > 0).length; // the two stretches to hold

  let state = 'ready'; // 'ready' | 'running' | 'finished'
  let index = -1; // the current step's position, -1 before start()
  let phase = 'done'; // 'intro' | 'hold' | 'after' | 'gap' | 'done'
  let stepElapsed = 0; // seconds since the current step began
  let holdElapsed = 0; // seconds since the current step's hold began
  let gapElapsed = 0; // seconds since the last step ended
  let countLast = 0; // highest countdown number already spoken
  let elapsed = 0; // total simulated seconds since start()
  let stretchesDone = 0;
  let endedThisCall = false; // one update() may not run on through a second step
  // The copy of the current step that goes out to the page. Every step object
  // handed out (onStep, onCountdown, `step`, and the `steps` list) is a copy,
  // so nothing outside can edit the workout's own steps: the same copy is used
  // for the whole step, so `step === ` the object onStep was given still works.
  let current = null;

  // The step being worked on. During the short beat between two steps this is
  // the step that just finished, so the coach holds its pose until the next one.
  const stepNow = () => (current && index >= 0 && index < steps.length ? current : null);

  function countNow() {
    if (state !== 'running' || phase !== 'hold') return null;
    return countLast;
  }

  // Speak every countdown number we have passed, highest first: 10, 9, 8 … 1.
  // Firing this way means a huge dt can never skip a number, and no number is
  // ever said twice.
  function emitCountdown() {
    const s = steps[index];
    const top = countMax(s);
    let n = Math.ceil(s.hold - holdElapsed);
    if (!Number.isFinite(n) || n > top) n = top;
    if (n < 1) n = 1;
    for (let v = countLast - 1; v >= n; v--) {
      if (v >= 1 && v <= top) call('onCountdown', current, v);
    }
    if (n < countLast) countLast = n;
  }

  function beginStep(i) {
    index = i;
    phase = 'intro';
    stepElapsed = 0;
    holdElapsed = 0;
    countLast = 0;
    current = { ...steps[i] };
    call('onStep', current, i);
  }

  function startHold() {
    phase = 'hold';
    holdElapsed = 0;
    countLast = countMax(steps[index]) + 1; // so the first number said is the top one
    emitCountdown();
  }

  function finishHold() {
    stretchesDone += 1;
    if (steps[index].after) {
      phase = 'after';
      // The line that closes the stretch, handed out the moment the hold ends. Without this the
      // step would sit in 'after' for its whole cap with nothing said and nothing on screen.
      call('onAfter', current, index);
    } else {
      endStep();
    }
  }

  function endStep() {
    if (index >= steps.length - 1) {
      finish();
      return;
    }
    phase = 'gap';
    gapElapsed = 0;
    endedThisCall = true;
  }

  function finish() {
    state = 'finished';
    phase = 'done';
    call('onFinish', {
      // How many of the workout's stretches were held all the way, and how many there were to do,
      // so the summary can honestly say "2 of 2 stretches" (main.js reads `total` that way).
      stretches: stretchesDone,
      total: STRETCH_COUNT,
      seconds: Math.round(elapsed * 100) / 100,
    });
  }

  // Advance the clock by at most dt and stop at the next event boundary.
  // Returns the seconds actually used.
  function tick(dt) {
    const s = steps[index];

    if (phase === 'intro') {
      // Wait for ready(); give up at the cap so the step can never hang.
      const room = Math.max(0, s.max - s.hold - stepElapsed);
      if (dt < room) {
        stepElapsed += dt; elapsed += dt;
        return dt;
      }
      stepElapsed += room; elapsed += room;
      if (s.hold > 0) startHold(); else endStep();
      return room;
    }

    if (phase === 'hold') {
      const room = Math.max(0, s.hold - holdElapsed);
      const use = Math.min(dt, room);
      holdElapsed += use; stepElapsed += use; elapsed += use;
      emitCountdown();
      if (dt >= room) finishHold();
      return use;
    }

    if (phase === 'after') {
      // Wait for ready() after the closing line, but never past the step's cap.
      const room = Math.max(0, s.max - stepElapsed);
      const use = Math.min(dt, room);
      stepElapsed += use; elapsed += use;
      if (dt >= room) endStep();
      return use;
    }

    if (phase === 'gap') {
      const room = Math.max(0, GAP - gapElapsed);
      const use = Math.min(dt, room);
      gapElapsed += use; elapsed += use;
      // One update() may finish a step and use up the beat, but must not run on
      // through the next step: a huge dt can never skip more than one step.
      if (dt >= room && !endedThisCall) beginStep(index + 1);
      return use;
    }

    return 0; // 'done'
  }

  function start() {
    if (state !== 'ready') return; // a second start() does nothing
    state = 'running';
    elapsed = 0;
    stretchesDone = 0;
    beginStep(0);
  }

  function update(dt) {
    // Anything that is not a positive, finite number of seconds does nothing.
    if (state !== 'running') return;
    if (typeof dt !== 'number' || !Number.isFinite(dt) || dt <= 0) return;
    endedThisCall = false;
    let left = dt;
    let guard = 0;
    while (left > EPS && guard++ < 256) {
      const beforePhase = phase;
      const beforeIndex = index;
      const used = tick(left);
      left -= used;
      if (!(used > 0) && phase === beforePhase && index === beforeIndex) break;
      if (state !== 'running') break;
    }
  }

  // "The line I was speaking has finished." Only matters while a step is
  // waiting for its line; between lines it does nothing.
  function ready() {
    if (state !== 'running') return;
    if (phase === 'intro') {
      if (steps[index].hold > 0) startHold(); else endStep();
    } else if (phase === 'after') {
      endStep();
    }
  }

  // Skip on now: instant, and it also skips the beat before the next step.
  function advance() {
    if (state === 'finished') return;
    if (state === 'ready') { start(); return; } // nothing to skip yet: just begin
    if (index >= steps.length - 1) { finish(); return; }
    beginStep(index + 1);
  }

  function reset() {
    state = 'ready';
    index = -1;
    phase = 'done';
    current = null;
    stepElapsed = 0; holdElapsed = 0; gapElapsed = 0;
    countLast = 0; elapsed = 0; stretchesDone = 0; endedThisCall = false;
  }

  // Which way the coach is leaning: +1 or -1 while the side stretch is being
  // held, and null at every other moment (so the pose layer can stand still).
  function sideNow() {
    if (state !== 'running' || phase !== 'hold' || index !== SIDE_INDEX) return null;
    return Math.floor(holdElapsed / SIDE_SWAP) % 2 === 0 ? 1 : -1;
  }

  return {
    start,
    update,
    ready,
    advance,
    reset,
    get state() { return state; },
    get index() { return index; },
    get step() { return stepNow(); },
    get countdown() { return countNow(); },
    get finished() { return state === 'finished'; },
    // A fresh copy of every step, so nothing outside can edit the workout's own.
    get steps() { return steps.map((s) => ({ ...s })); },
    get side() { return sideNow(); },
  };
}
