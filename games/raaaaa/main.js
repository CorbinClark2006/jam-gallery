// main.js — the game loop and the wiring: three.js on top of the camera, the coach in the room, and
// the workout's step machine, voice and buttons all pushed and pulled in the right order.

import * as THREE from 'three';
import * as T from 'jam/tuning';
import { startCamera, cameraHelp } from 'jam/camera';
import { loadCoach } from 'jam/coach';
import { createWorkout } from 'jam/workout';
import { createSpeech } from 'jam/speech';
import { createPlacement } from 'jam/placement';
import { loadOrientation } from 'jam/orientation';
import { loadEngine, createAr, enginePanelText } from 'jam/ar';
import { createUi } from 'jam/ui';

// The tracking engine does not bring its own three.js: XR8.Threejs builds its scene with
// `new window.THREE.Scene`, `new window.THREE.PerspectiveCamera` and `new window.THREE.WebGLRenderer`,
// read off the global object. This file imports three as a module, which puts it nowhere but here —
// so without this line the engine's three.js pipeline throws while building the scene, XR8.Threejs
// never has a scene to hand over, and the whole AR path dies before the first frame. The line has to
// run before the engine starts, and this module runs at page load, long before anyone taps.
window.THREE = THREE;

const DEG = Math.PI / 180;

// A caption is worth reading even when the voice is unavailable, so every line is held on screen
// for at least this long, scaled a little by how long the line is.
const LINE_MIN_MS = 900;
const LINE_PER_CHAR_MS = 45;
const LINE_MAX_MS = 6000;
// The frame's biggest step. A backgrounded tab returns with a huge dt, which must not teleport the
// coach or run the workout's countdown in one jump.
const MAX_DT = 0.05;

const canvas = document.getElementById('view');
const camEl = document.getElementById('cam');
const feedEl = document.getElementById('camerafeed'); // the engine's own canvas, hidden until it runs
const engineErrEl = document.getElementById('engine-err'); // where the engine's real error is printed

// ---- the 3D world ----------------------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.xr.enabled = true; // harmless now; it is what a real AR session will need later

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 200);

// Which scene, camera and renderer the frame is actually drawn through. Normally it is the three
// just above. When the world-tracking engine starts it builds its own three of them and these are
// pointed at the engine's instead — there must only ever be one camera owner and one thing drawing,
// so the game's own renderer and its animation loop are switched off at that moment.
let worldScene = scene;
let worldCamera = camera;
let worldRenderer = renderer;
let arMode = false;   // the engine owns the camera: the coach is anchored in the room, not in front
let ar = null;        // the tracking adapter, once it exists

// Two lights and no shadows: a neutral, bright setup that reads on any phone and costs nothing.
// There is no way to measure the room's real lighting, so this only has to look friendly.
const sky = new THREE.HemisphereLight(0xffffff, 0x8a8a94, 2.4);
sky.position.set(0, 1, 0);
scene.add(sky);
const key = new THREE.DirectionalLight(0xffffff, 1.8);
key.position.set(1.4, 2.6, 1.8);
scene.add(key);

// A soft dark oval on the floor under the coach. Without it he reads as a sticker floating over the
// camera feed; with it he reads as standing in the room. Drawn from a generated gradient, so it is
// code, not an asset file.
const shadow = makeShadow();
scene.add(shadow);

function makeShadow() {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(0,0,0,0.5)');
  grad.addColorStop(0.55, 'rgba(0,0,0,0.24)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, 0.95),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  mesh.rotation.x = -Math.PI / 2; // flat on the floor
  mesh.renderOrder = -1;
  return mesh;
}

// A flat gold ring showing where the coach would land. In AR it sits on the engine's own estimate of
// the floor, so the player can see the spot before committing to it. Generated in code, so it is not
// an asset file.
const reticle = makeReticle();
scene.add(reticle);

function makeReticle() {
  const geo = new THREE.RingGeometry(0.12, 0.17, 32);
  geo.rotateX(-Math.PI / 2);
  const ring = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color: 0xffd166, side: THREE.DoubleSide, transparent: true, opacity: 0.9,
  }));
  ring.visible = false;
  return ring;
}

// Everything the game draws, moved onto whichever scene is in charge. three.js reparents on add, so
// calling this when the engine takes over lifts the lights, the shadow, the ring and the coach out of
// the game's own scene and into the engine's — one scene, drawn by one renderer.
function moveWorldObjectsTo(target) {
  if (!target || target === worldScene) return;
  target.add(sky);
  target.add(key);
  target.add(shadow);
  target.add(reticle);
  if (coach) target.add(coach.object3D);
  worldScene = target;
}

// ---- the state --------------------------------------------------------------------------------

const speech = createSpeech();
const orientation = loadOrientation(() => {});
const placement = createPlacement({
  orientation,
  onNote: (text) => { note(text); },
});

// Camera and motion notes are worth saying once and are not worth leaving on the screen. Without
// this the "the coach is in front of you" line stayed up for the whole workout, pinned to the same
// corner as the captions and sitting on top of them.
let hintTimer = 0;
function note(text, ms) {
  ui.hint(text);
  clearTimeout(hintTimer);
  if (text) hintTimer = setTimeout(() => ui.clearHint(), ms || 5000);
}

let coach = null;          // the loaded coach, or null until the model has come in
let running = false;       // the workout is under way
let stretchTarget = 0;     // 1 while the coach should be holding a stretch, else 0
let stretchNow = 0;        // where the ramp actually is, eased toward the target every frame
let lastStretch = 'overhead'; // which stretch to keep posing while the ramp eases back down
let lastSide = 1;          // and which way it was leaning, so the lean does not flip on the way out
let lineToken = 0;         // which spoken line is the current one, so a stale one cannot advance us
let last = performance.now();
let fps = 0;
let shownCount = undefined; // the countdown number currently on screen, so it is only touched on change

const ui = createUi({
  onPlay: () => openStart(),
  onCamera: () => begin(true),
  onPreview: () => begin(false),
  onAction: () => startWorkout(),
  onMute: () => { speech.setMuted(!speech.muted); ui.setMuted(speech.muted); },
  onReplace: () => {
    // In AR this lifts him off the floor and waits for the next tap; elsewhere it re-aims him.
    placement.recenter();
    if (coach) coach.play('idle');
    refreshAction();
  },
  onQuit: () => finishEarly(),
  onSkip: () => { lineToken++; speech.stop(); workout.advance(); },
  onAgain: () => startWorkout(),
  onRestart: () => toStart(),
});

const workout = createWorkout({
  onStep: (step, index) => enterStep(step, index),
  // The line that closes a stretch ("Great job! That's our first stretch done."). Without this hook
  // the step would wait out its whole cap in silence, and the brief's closing line would never be
  // heard at all.
  onAfter: (step) => sayLine(step.after),
  onFinish: (summary) => finishWorkout(summary),
  // No onCountdown hook: the countdown is read from the workout's clock every frame instead, which
  // is the only way it can be correct at the moment a hold ends. See the loop.
});

// ---- the home card ------------------------------------------------------------------------------

// The coach is fetched at PAGE LOAD, not on the tap that needs him: the home card shows him waving
// before anything is tapped, and he cannot do that if he arrives after the tap. One promise is held
// here and shared with begin(), so whichever of the two asks first starts the fetch and the other
// waits on the same one — there is never a second copy of the model added to the scene.
let coachPromise = null;
function fetchCoach() {
  // The progress line goes to the hint, which is the only piece of screen furniture that can show
  // while the cards are up. On the home card it would sit on top of the title and the Play button for
  // as long as it takes to clear, so while the home card is up the fetch is quiet: the card itself is
  // the feedback, and Play's own "Getting your coach ready…" covers the wait after that.
  if (!coachPromise) coachPromise = loadCoach((status) => { if (!homeUp) note(status, 20000); });
  return coachPromise;
}

// True while the home card is the screen. It is what stops a model that arrives late from waving over
// a workout that has already begun.
let homeUp = true;

function homeCard() {
  ui.showHome(true);
  placement.setMode('preview'); // he stands in front of the lens, the same framing the no-camera workout uses
  fetchCoach().then((loaded) => {
    if (!loaded) return;
    coach = loaded;
    worldScene.add(coach.object3D);
    // Only while the home card is still up: by the time a slow model lands, the player may be halfway
    // into a workout, and begin() has already put him in his idle.
    if (homeUp) coach.play('wave');
    if (coach.fallback) note('I could not load my model, so this is a stand-in: ' + coach.reason, 12000);
  }).catch(() => { /* loadCoach never rejects; this is here so a bug in it cannot stop the page */ });
}

// Play. The home card makes way for the card that used to be the first thing anyone saw: the one that
// asks for the room, or offers the workout without the camera.
function openStart() {
  homeUp = false;
  ui.showHome(false);
  ui.showStart(true);
  // Inside the tap, so the phone lets it through: start fetching his seven lines now, and the time
  // spent reading the next card is time spent downloading them. A line that waits on its own
  // download arrives late, and on a slow phone it can stall in the middle of a sentence.
  speech.warm();
}

// ---- getting going ----------------------------------------------------------------------------

// Fetch the tracking engine NOW, at page load, not on the tap that needs it.
//
// This is not an optimisation. iOS only opens the camera and the motion sensors from inside a real
// user gesture, and the engine takes a megabyte of download before it can open anything. Fetching it
// at load leaves the tap with nothing to wait for but the start itself. The result is remembered
// rather than awaited on the way in, because startWorldTracking() below must be able to run
// synchronously from inside that tap.
let worldReady = false;   // true once the engine has signalled that it loaded
let worldLoaded = null;   // the engine's own answer: { ok, reason }
const enginePreload = loadEngine().then(
  (result) => { worldLoaded = result || { ok: false }; worldReady = !!worldLoaded.ok; return worldLoaded; },
  (err) => { worldLoaded = { ok: false, reason: 'The tracking engine could not be reached.' }; return worldLoaded; },
);

// One tap does everything that the browser insists must happen inside a user gesture: the motion
// permission prompt, and the camera. Order matters — on iOS the sensor prompt is only shown from a
// real tap, and awaiting the camera first can spend that gesture.
async function begin(withCamera) {
  ui.showStart(false);
  note(withCamera ? 'Starting the camera…' : 'Getting your coach ready…', 20000);

  if (withCamera) {
    // World tracking first. If the engine comes up, it owns the camera and the coach stands at a real
    // spot in the room. If it cannot load, that is said out loud and we fall back to the old
    // camera-with-rotation-sensors path — which is a different thing, and is labelled as one.
    if (await startWorldTracking()) {
      ui.clearHint();
    } else {
      orientation.enable(); // not awaited: it must fire inside this same tap
      try {
        await startCamera(camEl);
        ui.clearHint();
      } catch (err) {
        // The camera is not available. That is not a dead end: the workout still runs, and the
        // player is told plainly why they are seeing the preview instead of their room.
        note(cameraHelp(err) + ' Starting the no-camera preview instead.', 8000);
        placement.setMode('preview');
      }
    }
  } else {
    placement.setMode('preview');
  }

  if (!coach) {
    coach = await fetchCoach();
    worldScene.add(coach.object3D); // already the engine's scene, if the engine came up first
    if (coach.fallback) note('I could not load my model, so this is a stand-in: ' + coach.reason, 12000);
  }
  if (coach.fallback && !arMode) placement.setMode('preview');

  // He starts standing and breathing, waiting to be told to begin.
  coach.play('idle');
  if (!arMode) {
    placement.place();
    if (!coach.fallback) {
      // placement.place() has already said where he is; this says what to do about it. It replaces
      // that line rather than stacking under it, and it fades on its own.
      note(modeNote(), 4500);
    }
  }

  ui.showHud(true);
  refreshAction();
  ui.showDone(false);
}

// What the big button says, which is not the same thing in the two modes. With world tracking the
// player has to put the coach down before there is anything to start: a Start button that began a
// workout around an invisible coach would be worse than no button.
function refreshAction() {
  if (arMode && !placement.worldPlaced) {
    ui.setTitle('Find the floor');
    ui.setCaption('Point the phone at the floor and move it slowly. When the gold ring appears, tap it to put me down.');
    ui.setAction(null, false);
    return;
  }
  ui.setTitle('Ready when you are');
  ui.setCaption('I am Coach Milo. Tap start and we will do two stretches together.');
  ui.setAction('Start workout', true);
}

// ---- world tracking --------------------------------------------------------------------------

// Bring the engine up. Returns true when it is running and owns the camera, false when the game
// should fall back to the plain camera. This never throws: a missing engine is a fallback, not a
// broken game.
//
// The engine was fetched at page load (see the preload above). That matters here: the one await is
// only reached if someone tapped faster than a megabyte could arrive. On the normal path nothing is
// awaited before ar.start(), so XR8.run() runs in the same task as the tap, with the user gesture
// still attached to it — which is what iOS wants before it will open a camera.
async function startWorldTracking() {
  note('Starting world tracking…', 20000);

  if (!worldReady) {
    note('Waiting for the tracking engine…', 8000);
    await enginePreload;
  }
  if (!worldReady) {
    note((worldLoaded && worldLoaded.reason ? worldLoaded.reason : 'World tracking is unavailable.') +
      ' Using the camera without it.', 9000);
    return false;
  }

  ar = createAr({
    // The engine's own loop drives the game's frame. There is exactly one loop running at a time.
    onFrame: ({ dt }) => { frame(dt); },
    onNote: (text) => note(text, 6000),
    onError: (text) => engineFailed(text),
  });

  ar.start({
    canvas: feedEl,
    onScene: ({ scene: engineScene, camera: engineCamera, renderer: engineRenderer }) => {
      arMode = true;
      placement.setMode('ar');
      worldCamera = engineCamera;
      worldRenderer = engineRenderer;
      moveWorldObjectsTo(engineScene);
      feedEl.hidden = false;
      camEl.hidden = true;
      canvas.hidden = true;
      // The game's own renderer and loop stop here: the engine is drawing now, and two renderers
      // fighting over the screen is exactly the mess this is meant to avoid.
      renderer.setAnimationLoop(null);
      if (coach) coach.object3D.visible = false;
      installArTap();
      installArPinch();
      if (ui) refreshAction();
    },
  });

  note('Point the phone at the floor and move it slowly.', 8000);
  return true;
}

// The engine saying it could not come up. If it never got as far as handing over a scene, the player
// is looking at a screen with no room in it: put the labelled non-AR path in its place and say why.
// This is a fallback that is said out loud, never a silent one — the player is told tracking failed
// and told what they are seeing instead.
// Where a tracking failure is written so it can actually be read on a phone. It is not the caption
// bar: the engine puts its own opaque error panels over everything at z-index 999, and the caption
// bar is underneath them. This one is above, and it always carries the engine's own words when the
// engine wrote any — those are the words its own screen throws away.
function engineErrorLine(text) {
  if (!engineErrEl) return;
  const panel = enginePanelText();
  engineErrEl.textContent = (panel ? text + '  ·  engine: ' + panel : text);
  engineErrEl.hidden = false;
}

let fallingBack = false;
async function engineFailed(text) {
  engineErrorLine(text);
  if (arMode || fallingBack) { note(text, 9000); return; }
  fallingBack = true;

  if (ar) ar.stop();
  placement.setMode('preview');
  feedEl.hidden = true;

  // The gesture that started the engine is long gone by now, so the motion prompt may be refused.
  // orientation.enable() reports that through its own note; either way the workout still runs.
  orientation.enable();
  try {
    await startCamera(camEl);
  } catch (err) {
    note(cameraHelp(err) + ' Starting the no-camera preview instead.', 8000);
  }
  if (coach && !placement.worldPlaced) placement.place();
  refreshAction();
  // Last, so it is the line still on screen: the reason the room is not in the picture is the one
  // thing worth reading, and every note above would otherwise have pushed it off.
  note(text, 14000);
}

// Tapping the floor puts the coach down. The position the engine returns is world coordinates and is
// written once; after that the camera moves and the coach does not, which is the whole point.
function installArTap() {
  if (!ar || !feedEl) return;
  feedEl.addEventListener('touchstart', (event) => {
    if (!ar || arMode === false) return;
    if (event.touches.length !== 1) return;
    if (placement.worldPlaced) return; // already down: use Move coach to lift him first
    const t = event.touches[0];
    const hit = ar.place(t.clientX / window.innerWidth, t.clientY / window.innerHeight);
    if (!hit) {
      note('No floor under that point yet. Move the phone slowly over the floor and try again.', 6000);
      return;
    }
    // His facing is frozen with his position — a direction in the room, not one that follows the
    // phone. COACH_TURN_DEG is the knob to add 180 to, if he ever ends up with his back to you.
    const yaw = Math.atan2(worldCamera.position.x - hit.position.x,
                            worldCamera.position.z - hit.position.z) + (Number(T.COACH_TURN_DEG) || 0) * DEG;
    placement.setWorldPlacement(hit.position, yaw);
    if (coach) coach.play('idle');
    if (!hit.reliable) note('That was a guess rather than a confirmed floor. If he floats, tap Move coach.', 9000);
    refreshAction();
  }, { passive: true });
}

// Two fingers make him bigger or smaller. This is the only gesture in the game that is not the
// workout's action, and it shares the tap surface with placing him, so the two are told apart by how
// many fingers are down: one finger places, two resize. It works before he is placed too, so the
// size can be set before he is put down.
let pinchBound = false;
function installArPinch() {
  if (!ar || !feedEl || pinchBound) return;
  pinchBound = true;

  // The distance between the two fingers, in screen pixels. Only the RATIO of this from the start of
  // the gesture to now matters, so it does not matter what the number itself is.
  const gap = (touches) => Math.hypot(
    touches[0].clientX - touches[1].clientX,
    touches[0].clientY - touches[1].clientY,
  );

  let startGap = 0;
  let startScale = 1;
  let pinching = false;

  feedEl.addEventListener('touchstart', (event) => {
    if (event.touches.length !== 2) return;
    pinching = true;
    startGap = gap(event.touches);
    startScale = placement.scale; // relative to where THIS pinch started, so it cannot run away
  }, { passive: true });

  feedEl.addEventListener('touchmove', (event) => {
    if (!pinching || event.touches.length !== 2) return;
    event.preventDefault(); // no page zoom and no rubber-banding while he is being resized
    const now = gap(event.touches);
    if (!startGap || !now) return;
    placement.setScale(startScale * (now / startGap));
  }, { passive: false });

  // Said once, when the fingers come off, rather than sixty times a second. Centimetres because that
  // is the number a player can check against the room they are standing in.
  const done = () => {
    if (!pinching) return;
    pinching = false;
    const scale = placement.scale;
    note('Coach size ×' + scale.toFixed(2) + ' — about ' +
      Math.round((Number(T.COACH_HEIGHT_M) || 1.9) * scale * 100) + ' cm tall.', 4000);
  };
  feedEl.addEventListener('touchend', done);
  feedEl.addEventListener('touchcancel', done);
}

// One plain line about how the coach is being held in place, in the player's own terms. The two
// modes are not the same thing and the game never pretends they are.
function modeNote() {
  if (placement.mode === 'preview') return 'No camera, so he is standing in front of you.';
  return 'Turn the phone to look around him — he stays where he is.';
}

function startWorkout() {
  if (!coach) return;
  note('', 0); // the notes have done their job; the screen belongs to the workout now
  ui.showDone(false);
  ui.setAction(null, false);
  stretchTarget = 0;
  stretchNow = 0;
  running = true;
  workout.reset();
  workout.start();
}

function enterStep(step) {
  ui.setTitle(step.title);
  ui.setCountdown(null);
  coach.play(clipFor(step));
  sayLine(step.say);
}

// Which real clip to play for a workout step. The pack's `stand_up` clip starts from a SITTING hip
// height (0.48 m, measured in the file), so playing it while the coach is standing would yank him
// into a sit first. He stands throughout, so the standing-up step talks instead.
//
// THE MAKER'S CALL (2026-11-06): the coach starts STANDING, not seated on the floor. The brief asked
// for a floor-sit opening, but this pack's `sit` is a CHAIR sit — hips at 0.48 m with the feet flat
// on the ground — so played as-is he perches on nothing in mid-air. Making it a real floor-sit means
// hand-building the leg fold. Offered that work, the maker chose the standing start instead. The
// `sit`, `sit_down` and `stand_up` clips stay wired into the mixer in coach.js, unused and ready.
function clipFor(step) {
  switch (step.pose) {
    case 'wave': return 'wave';
    case 'standUp': return 'talking';
    case 'overhead': return 'idle'; // the stretch itself is posed on the skeleton, not a clip
    case 'side': return 'idle';
    case 'cheer': return 'cheer';
    case 'talking': return 'talking';
    default: return 'idle';
  }
}

// Show a caption and speak the line, then let the workout know the line is done. The token is what
// keeps a line that has been abandoned — because the player skipped on — from advancing a step that
// has already finished.
async function sayLine(line) {
  if (!line) { workout.ready(); return; }
  const mine = ++lineToken;
  ui.setCaption(line);
  const from = performance.now();
  try { await speech.speak(line); } catch (err) { /* speak() never rejects, but never assume */ }
  const wanted = Math.min(LINE_MAX_MS, LINE_MIN_MS + line.length * LINE_PER_CHAR_MS);
  const left = wanted - (performance.now() - from);
  if (left > 0) await sleep(left);
  if (mine !== lineToken) return; // a newer line has taken over
  ui.setCaption('');
  workout.ready();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// ---- finishing --------------------------------------------------------------------------------

function finishWorkout(summary) {
  running = false;
  note('', 0);
  stretchTarget = 0;
  ui.setCountdown(null);
  ui.setCaption('');
  ui.setAction(null, false);
  coach.play('cheer');
  ui.setTitle('Workout complete');
  const done = saveCompletion();
  // Tick off only the stretches that actually ran to the end: if the player skipped one, the panel
  // should say so rather than hand out a tick they did not earn.
  const did = summary && Number.isFinite(summary.stretches) ? summary.stretches : 2;
  const of = summary && Number.isFinite(summary.total) ? summary.total : 2;
  const lines = [];
  if (did >= 1) lines.push('✓ Overhead stretch');
  if (did >= 2) lines.push('✓ Side stretch');
  lines.push(did + ' of ' + of + ' stretches');
  if (done) lines.push('Saved on this phone (' + done + ')');
  // Finished with nothing counted means the player skipped the whole thing, and the panel should
  // not pretend otherwise — nor should it scold them for it.
  const closing = did === 0
    ? 'Skipped this one. Come back when you have a minute and we will do the stretches properly.'
    : did < of
      ? 'You stopped early on one. That is fine — come back and we will finish it.'
      : 'Nice work. Come back tomorrow and we will do it again.';
  ui.showSummary(did === 0 ? 'Skipped ahead' : 'Workout complete', lines, closing);
  ui.showDone(true);
}

function finishEarly() {
  running = false;
  note('', 0);
  lineToken++; // abandon whatever was being said
  speech.stop();
  stretchTarget = 0;
  workout.reset();
  ui.setCountdown(null);
  ui.setCaption('');
  ui.showSummary('Ending here', ['Overhead stretch', 'Side stretch'],
    'That is fine. Come back when you have a minute and we will finish it.');
  ui.showDone(true);
}

// Only ever local, never sent anywhere, and it must not throw on a browser that refuses storage
// (Safari in private mode does exactly that).
function saveCompletion() {
  try {
    const key = 'coach-milo-workouts';
    const count = (parseInt(localStorage.getItem(key) || '0', 10) || 0) + 1;
    localStorage.setItem(key, String(count));
    return count;
  } catch (err) {
    return 0;
  }
}

function toStart() {
  running = false;
  lineToken++;
  speech.stop();
  ui.reset();
  ui.showStart(true);
  placement.recenter();
}

// ---- one frame ---------------------------------------------------------------------------------

// Everything that happens in a frame, with no assumption about who is drawing it: the game's own
// loop calls this and then renders, and in AR mode the engine's pipeline calls this and the engine
// draws. Nothing in here may ever wait on the model, the camera or the voice.
function frame(dt) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const aspect = h > 0 ? w / h : 1;

  // In AR the engine owns the camera's field of view and its projection, and touching either here
  // would fight it and make the whole room swim. Anywhere else the framing is ours, and it has to
  // follow the shape of the screen.
  if (!arMode) {
    if (canvas.width !== Math.round(w * worldRenderer.getPixelRatio()) ||
        canvas.height !== Math.round(h * worldRenderer.getPixelRatio())) {
      worldRenderer.setSize(w, h, false);
    }
    const fit = placement.frame(aspect);
    if (worldCamera.fov !== fit.fovDeg || worldCamera.aspect !== fit.aspect) {
      worldCamera.fov = fit.fovDeg;
      worldCamera.aspect = fit.aspect;
      worldCamera.updateProjectionMatrix();
    }
  }

  if (coach) {
    placement.update(coach.object3D, aspect);

    // The stretch ramp. The target is 1 for exactly as long as a stretch step is the current one,
    // so the arms come up as he explains it and go down when the step is over. Frame-rate
    // independent, and it never jumps.
    const step = workout.step;
    const onStretch = running && !!step && (step.id === 'overhead' || step.id === 'side');
    stretchTarget = onStretch ? 1 : 0;
    const k = 1 - Math.exp(-(Number(T.COACH_STRETCH_RAMP) || 1.1) * dt);
    stretchNow += (stretchTarget - stretchNow) * k;
    if (stretchNow < 0.002 && !onStretch) stretchNow = 0;

    if (onStretch) {
      // Remember which stretch and which way, so that as the ramp comes back down the coach eases
      // out of the pose he was actually in. Otherwise his lean would vanish on the first frame of
      // the next step instead of fading out with everything else.
      lastStretch = step.id;
      lastSide = workout.side || lastSide;
      coach.setStretch(lastStretch, stretchNow, lastSide);
    } else {
      coach.setStretch(stretchNow > 0 ? lastStretch : null, stretchNow, lastSide);
    }

    coach.update(dt);

    // The shadow belongs on the floor under his feet, and it disappears with him when he has not
    // been put down yet. It follows his size as well as his spot: the plane was made for a 1.9 m
    // figure, so a pinched-down coach would otherwise stand in a full-size shadow.
    shadow.visible = coach.object3D.visible;
    shadow.position.set(coach.object3D.position.x, coach.object3D.position.y + 0.004, coach.object3D.position.z);
    shadow.scale.setScalar(coach.object3D.scale.x || 1);
  }

  updateReticle();

  workout.update(dt);

  // The countdown is read from the workout's own clock every frame rather than waited for on its
  // callback. The callback fires once per number, so when a hold ends there is nothing left to tell
  // the screen to stop showing the last one, and a stale "1" would sit there through the closing
  // line. The guard below keeps it from rewriting the same digit sixty times a second.
  const count = workout.countdown;
  if (count !== shownCount) {
    shownCount = count;
    ui.setCountdown(count);
  }
}

// The ring that says "he lands here", while the player is still looking for the floor. It is driven
// by the same hit test the tap uses, so the ring and the tap can never disagree about the spot.
function updateReticle() {
  if (!arMode || !ar || placement.worldPlaced) { reticle.visible = false; return; }
  const hit = ar.previewHit(0.5, 0.62);
  if (!hit) { reticle.visible = false; return; }
  reticle.position.set(hit.position.x, hit.position.y + 0.005, hit.position.z);
  reticle.material.color.set(hit.reliable ? 0xffd166 : 0xffffff);
  reticle.visible = true;
}

// The home card goes up before the first frame: the coach is behind it from the start, arriving when
// the model does rather than when something is tapped.
homeCard();

// three.js's own loop, rather than requestAnimationFrame, because that is the one an AR session
// takes over. It runs until the engine takes the camera, and then it is switched off — one loop,
// one renderer, all the way through.
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(Math.max((now - last) / 1000, 0), MAX_DT);
  last = now;
  if (dt > 0) fps = fps ? fps * 0.9 + (1 / dt) * 0.1 : 1 / dt;

  frame(dt);
  worldRenderer.render(worldScene, worldCamera);
});

// The workout's own clock is driven from the loop above, but a resized window or a phone turned over
// changes the framing, and the camera has to follow it. That happens in the loop.

// ---- the debug line, for when something looks wrong -------------------------------------------
// Reachable by adding ?fps to the address, so it is there when it is wanted and invisible when not.

if (/[?&]fps\b/.test(location.search)) {
  const box = document.createElement('pre');
  box.style.cssText = 'position:fixed;left:0;bottom:0;z-index:9;margin:0;padding:6px 8px;' +
    'background:rgba(0,0,0,0.7);color:#9ff;font:11px/1.4 ui-monospace,Menlo,monospace;pointer-events:none';
  document.body.append(box);
  setInterval(() => {
    const info = worldRenderer.info.render;
    const cam = worldCamera.position;
    box.textContent = [
      Math.round(fps) + ' fps',
      info.calls + ' draws · ' + info.triangles + ' tris',
      'place: ' + placement.label,
      'size: ×' + placement.scale.toFixed(2) + ' · ' +
        Math.round((Number(T.COACH_HEIGHT_M) || 1.9) * placement.scale * 100) + ' cm',
      'ar: ' + (arMode ? 'engine ' + (ar ? ar.tracking || 'starting' : '—') : 'off') +
        (arMode ? ' · you ' + cam.x.toFixed(2) + ', ' + cam.y.toFixed(2) + ', ' + cam.z.toFixed(2) : ''),
      'engine: ' + (enginePanelText() || '—'),
      'coach: ' + (coach ? (coach.fallback ? 'FALLBACK ' + coach.reason : coach.playing + (coach.stretching ? ' + ' + coach.stretching : '')) : 'not loaded'),
      'bones: ' + (coach ? coach.bones.length : 0) + ' · clips: ' + (coach ? coach.clips.length : 0),
      'workout: ' + workout.state + ' #' + workout.index + (workout.countdown !== null ? ' (' + workout.countdown + ')' : ''),
      'speech: ' + (speech.supported ? (speech.muted ? 'muted' : 'on') : 'unavailable') + (speech.voice ? ' · ' + speech.voice : ''),
      'tilt: ' + (orientation.tracking ? 'tracking' : orientation.lost ? 'lost' : 'none'),
      'model: ' + (coach && coach.clips.length ? coach.clips.join(' ') : '—'),
    ].join('\n');
  }, 400);

  // With ?fps on, the coach himself is reachable from the console as window.coach — a live handle on
  // the loaded model, its bones and the pose it is holding. It is how the stretch angles were checked
  // against the bone that is actually on screen, and it costs nothing when the flag is off.
  Object.defineProperty(window, 'coach', { get: () => coach, configurable: true });
}
