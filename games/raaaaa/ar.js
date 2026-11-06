// ar.js — 8th Wall world-tracking adapter: engine loading, the camera pipeline, and floor hit tests.

/*
  This is the only file that knows the tracking engine exists. main.js keeps being a plain three.js
  game: it hands this module a canvas and two callbacks, and gets back a scene, a camera, and a way
  to ask "is there floor under this point of the screen?". Nothing else in the project imports 8th
  Wall, and this file imports nothing at all — three.js is main.js's business, because main.js is
  the one that imports it (setting window.THREE here would give the page two copies of the library).

  Three things about the engine are easy to get wrong, and each one costs an afternoon:

  1. The engine binary is fetched with data-preload-chunks="slam". Without that attribute the SLAM
     chunk — the part that actually does world tracking — is never downloaded, and the engine sits
     at "Limited" forever because it has no tracking to do.
  2. XR8.XrController.configure() has to run BEFORE the XrController pipeline module is added and
     before XR8.run(). The setting cannot be changed afterwards. scale:'absolute' is what makes every
     position the engine reports a real distance in metres; the default, 'responsive', ties the
     world's scale to the frame-1 camera, so a 1.77 m coach placed in a small room comes out tiny.
  3. The three.js camera must not start at y = 0. The engine's own troubleshooting page lists that
     exact case ("6DoF camera motion not working — the camera's Y position is zero") as a reason for
     tracking never getting going, so we start it at (0, 2, 2) like the official example does.

  Everything here is defensive about the engine's API surface, because it is whatever build the CDN
  hands us today: every call that could throw on a half-loaded engine is fenced, and anything
  missing is reported in plain words rather than thrown at the game loop.
*/

const ENGINE_SRC = 'https://cdn.jsdelivr.net/npm/@8thwall/engine-binary@1/dist/xr.js';
const EXTRAS_SRC = 'https://cdn.jsdelivr.net/npm/@8thwall/xrextras@1/dist/xrextras.js';

// Long enough for a slow phone network, short enough that nobody stares at a spinner for a minute.
const LOAD_TIMEOUT_MS = 25000;
// One message for every way the CDN can let us down: the player can do the same thing about all of
// them, so there is no reason to make them read four variations of it.
const LOAD_FAILED = 'The tracking engine never loaded. It is fetched from a CDN, so check the connection and reload.';

let enginePromise = null; // one page, one load: a second call gets the first call's promise

const msg = (err) => (err && err.message) ? err.message : String(err);
const copy = (p) => ({ x: p.x, y: p.y, z: p.z });
const noop = function () {};

// The engine does not throw ordinary Errors. It throws objects shaped {type, source, err, message},
// and that triple is the diagnosis — the screen it shows a player says only "Oops, something went
// wrong!". Whatever is present gets printed: on a phone this sentence is the only place the reason
// will ever be seen.
function describeError(err) {
  if (!err) return 'none';
  if (typeof err !== 'object') return String(err);
  const bits = [];
  if (err.type) bits.push('type=' + err.type);
  if (err.source) bits.push('source=' + err.source);
  if (err.err) bits.push('err=' + err.err);
  if (err.permission) bits.push('permission=' + err.permission);
  if (err.message) bits.push('msg=' + err.message);
  if (err.name && !err.message) bits.push('name=' + err.name);
  return bits.length ? bits.join(' ') : String(err);
}

// The engine's own error panel. When the engine decides something is fatal it writes the reason into
// this element and then covers the screen with it, so reading the element back is how the line under
// "Oops, something went wrong!" is recovered. The element is injected when the engine starts, so it
// may not exist yet — and it belongs to the engine, so this only ever reads.
export function enginePanelText() {
  try {
    const el = document.getElementById('camera_mode_world_tracking_error');
    if (!el) return '';
    return (el.textContent || '').trim();
  } catch (err) {
    return '';
  }
}

// The engine is one session per page, so what it hands us lives out here at module scope: the
// pipeline module fills these in, the accessors below read them.
let scene = null;
let camera = null;
let renderer = null;
let configured = false;
let tracking = null;
let reason = null;
let placedPos = null;
let placed = false;

// Load the engine. Resolves {ok:true} once the engine signals, or {ok:false, reason} in plain
// English. It never rejects: a caller that forgets .catch() should still get a sentence, not an
// unhandled rejection in the console.
export function loadEngine() {
  if (enginePromise) return enginePromise;

  enginePromise = new Promise((resolve) => {
    try {
      // Already on the page (a reload after the script was cached, or a second call from another
      // module): nothing to inject.
      if (window.XR8) { resolve({ ok: true }); return; }

      // Safari and Chrome only open a camera to a secure origin, and 8th Wall needs the camera.
      // Deciding this before injecting means the player is not asked to download an engine that
      // could never have run.
      if (location.protocol !== 'https:') {
        resolve({ ok: false, reason: 'World tracking needs an https:// address.' });
        return;
      }

      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      // The page carries the engine's script tags in <head> (see index.html) so that the tap which
      // needs the engine does not have to wait for a megabyte first. If they are there, all this has
      // to do is wait for them: nothing to inject, and a shorter patience, because a script tag that
      // is already on the page has either loaded or failed and we would rather say so.
      const onPage = !!document.querySelector('script[src*="@8thwall/engine-binary"]');
      const timer = setTimeout(() => finish({ ok: false, reason: LOAD_FAILED }), onPage ? 15000 : LOAD_TIMEOUT_MS);
      window.addEventListener('xrloaded', () => finish({ ok: true }));
      if (onPage) return;

      const engine = document.createElement('script');
      engine.src = ENGINE_SRC;
      engine.async = true;
      engine.crossOrigin = 'anonymous';
      // Mandatory: this attribute is what fetches the world-tracking wasm chunk.
      engine.setAttribute('data-preload-chunks', 'slam');
      // Without this the script tag fails silently and the player waits out the whole timeout.
      engine.addEventListener('error', () => finish({ ok: false, reason: LOAD_FAILED }));

      const extras = document.createElement('script');
      extras.src = EXTRAS_SRC;
      extras.crossOrigin = 'anonymous';

      // The engine first, then its extras, and the listener above is attached before either is
      // added: the binary can load and fire xrloaded before the next line runs.
      document.head.appendChild(engine);
      document.head.appendChild(extras);
    } catch (err) {
      resolve({ ok: false, reason: 'The tracking engine could not be started: ' + msg(err) });
    }
  });

  return enginePromise;
}

// Build one AR session. The three callbacks are all optional; a callback that throws is the
// caller's problem, not the engine's, so every call into them is fenced.
export function createAr(options) {
  const opts = options || {};
  const onFrame = typeof opts.onFrame === 'function' ? opts.onFrame : noop;
  const onNoteIn = typeof opts.onNote === 'function' ? opts.onNote : noop;
  const onErrorIn = typeof opts.onError === 'function' ? opts.onError : noop;
  const note = (text) => { try { onNoteIn(text); } catch (err) { /* never break the engine loop */ } };
  const fail = (text) => { try { onErrorIn(text); } catch (err) { /* never break the engine loop */ } };

  let last = 0;            // ms timestamp of the previous frame, for dt
  let reported = null;     // the last tracking status we already told the player about
  // Held here, not in start(): the pipeline module below is built in this scope, so a local of
  // start() would be out of its reach and the scene would silently never reach the caller.
  let sceneCallback = null;

  // Which hit, if any, is good enough to stand the coach on.
  //
  // hitTest can return a real detected or estimated surface, or it can return a lone feature point.
  // A surface is a floor the engine believes in, so it is taken as it comes. A feature point is only
  // "some texture the camera can see" — it may be a wall, a poster or mid-air — so it counts as floor
  // only when it sits well below the camera, and even then it is reported as unreliable so the caller
  // can keep the reticle looking like a guess instead of passing it off as a floor.
  function pickHit(nx, ny) {
    let hits = [];
    try { hits = XR8.XrController.hitTest(nx, ny, ['FEATURE_POINT']) || []; }
    catch (err) { fail('hitTest failed: ' + msg(err)); return null; }
    const list = Array.isArray(hits) ? hits : [];
    const surface = list.find((h) => h && h.position &&
      (h.type === 'DETECTED_SURFACE' || h.type === 'ESTIMATED_SURFACE'));
    if (surface) return { position: copy(surface.position), type: surface.type, reliable: true };
    const loose = list.find((h) => h && h.position && h.type === 'FEATURE_POINT');
    const camY = camera ? camera.position.y : NaN;
    if (loose && Number.isFinite(camY) && loose.position.y < camY - 0.3) {
      return { position: copy(loose.position), type: loose.type, reliable: false };
    }
    return null;
  }

  // World tracking is off by default on some builds, and the reported scale is the difference
  // between a coach who is his real height and a coach the size of a thimble. This has to happen
  // before the pipeline modules are added: after that the engine throws rather than reconfigure.
  function configure() {
    if (typeof XR8 === 'undefined' || !XR8.XrController || typeof XR8.XrController.configure !== 'function') {
      fail('This build of the tracking engine has no world-tracking settings.');
      return;
    }
    try {
      XR8.XrController.configure({
        disableWorldTracking: false, // SLAM stays on: it is the whole point of the module
        // scale:'absolute' is what makes every reported position a real distance in metres; the
        // default, 'responsive', ties the world scale to the frame-1 camera instead.
        scale: 'absolute',
        enableLighting: false,      // the coach is lit by the game, not by the room
        enableWorldPoints: false,   // the debug point cloud is not something a player should see
      });
      configured = true;
    } catch (err) {
      fail('The tracking engine would not turn on world tracking: ' + msg(err));
    }
  }

  // The camera pipeline module. The engine calls these hooks; the game never does.
  function buildModule() {
    return {
      name: 'coach-ar',
      onStart: ({ canvas: feed }) => {
        // XR8.Threejs builds the scene, the camera and the renderer for us, and hands them over
        // here. It builds them out of a GLOBAL three.js (see window.THREE in main.js), so if that is
        // missing there is nothing to hand over and this comes back null. Reading .scene off null is
        // a TypeError that says nothing about the cause, so it is checked and said in words.
        const xr = (XR8.Threejs && typeof XR8.Threejs.xrScene === 'function') ? XR8.Threejs.xrScene() : null;
        if (!xr || !xr.scene || !xr.camera || !xr.renderer) {
          fail('The engine could not build its three.js scene' +
            (window.THREE ? '.' : ', because window.THREE is not set — the engine reads three.js off the global object.') +
            ' World tracking cannot start without it.');
          return;
        }
        scene = xr.scene;
        camera = xr.camera;
        renderer = xr.renderer;
        // The camera MUST NOT start at y = 0: the engine will not track it through the room if it
        // does ("6DoF camera motion not working — the camera's Y position is zero"). The official
        // three.js example starts it at (0, 2, 2).
        camera.position.set(0, 2, 2);
        camera.quaternion.identity();
        XR8.XrController.updateCameraProjectionMatrix({ origin: camera.position, facing: camera.quaternion });
        if (typeof sceneCallback === 'function') {
          try { sceneCallback({ scene, camera, renderer, canvas: feed }); }
          catch (err) { fail(msg(err)); }
        }
        last = performance.now();
      },
      // The engine reports the camera step by step: requesting, hasStream, hasVideo, failed. When it
      // fails, `reason` is the whole answer, and the engine's own error screen says only "Oops,
      // something went wrong" — so this is the difference between a fixable message and a mystery.
      onCameraStatusChange: (info) => {
        const status = (info && info.status) ? info.status : '?';
        const why = (info && info.reason) ? ' (' + info.reason + ')' : '';
        if (status === 'failed') fail('The camera could not be opened' + why + '.');
        else if (status !== 'requesting') note('Camera: ' + status + why);
      },
      // Anything the engine itself throws arrives here with the real diagnosis on it.
      onException: (err) => {
        fail('Tracking engine error: ' + describeError(err) + '.');
      },
      onUpdate: ({ processCpuResult }) => {
        const now = performance.now();
        // Clamped: a backgrounded tab comes back with a delta of many seconds, and one step that
        // big would teleport anything the caller moves with dt.
        const dt = Math.min(Math.max((now - last) / 1000, 0), 0.05);
        last = now;
        const reality = processCpuResult && processCpuResult.reality;
        if (reality) {
          tracking = reality.trackingStatus || tracking;
          reason = reality.trackingReason || null;
        }
        try { onFrame({ dt, camera, scene, renderer, reality, tracking, reason, placed }); }
        catch (err) { fail(msg(err)); }
      },
      listeners: [
        // The engine also announces status changes as an event. Reporting from the event, not from
        // the frame, is what gets the player one line at the moment things change instead of the
        // same line sixty times a second.
        { event: 'reality.trackingstatus', process: ({ detail }) => {
            const status = detail && detail.status ? detail.status : null;
            if (status) tracking = status;
            if (detail && detail.reason) reason = detail.reason;
            if (status && status !== reported) {
              reported = status;
              const why = detail && detail.reason ? ' (' + detail.reason + ')' : '';
              note('Tracking is now ' + status + why + '.');
            }
          } },
      ],
    };
  }

  // Register the pipeline and open the camera. Returns nothing useful on purpose: the engine tells
  // us how it went through the callbacks, not through a value.
  function start(args) {
    const a = args || {};
    const canvas = a.canvas || null;
    // Only replaced when a real one is given: a second start() that forgets it should not silently
    // leave the game with no scene to draw in.
    if (typeof a.onScene === 'function') sceneCallback = a.onScene;

    // configure() first, always: the engine refuses the world-tracking switch once the pipeline
    // modules are in.
    configure();

    // Every one of these is a separate member on the engine object and any of them can be absent on
    // an older build. A missing one is skipped and said out loud, rather than taking the whole
    // start-up down with it.
    const modules = [];
    const add = (label, make) => {
      try { modules.push(make()); }
      catch (err) { fail('The tracking engine has no ' + label + ', so that step is skipped: ' + msg(err)); }
    };
    add('XR8.GlTextureRenderer', () => XR8.GlTextureRenderer.pipelineModule()); // draws the camera feed
    add('XR8.Threejs', () => XR8.Threejs.pipelineModule());                     // the three.js AR scene
    add('XR8.XrController', () => XR8.XrController.pipelineModule());           // SLAM world tracking
    add('XRExtras.FullWindowCanvas', () => {
      if (typeof XRExtras === 'undefined') throw new Error('XRExtras did not load');
      return XRExtras.FullWindowCanvas.pipelineModule();
    });
    add('XRExtras.Loading', () => {
      if (typeof XRExtras === 'undefined') throw new Error('XRExtras did not load');
      return XRExtras.Loading.pipelineModule();
    });
    // XRExtras.RuntimeError is deliberately NOT added. It exists to put a friendly full-screen panel
    // in front of a player when the engine fails, and its panel reads "Oops, something went wrong!"
    // with nothing underneath it: it covers the game's own captions, which is where the reason
    // actually goes. The game already has a caption bar, and onCameraStatusChange/onException above
    // write the real diagnosis there instead.
    add('coach-ar module', () => buildModule());

    try { XR8.addCameraPipelineModules(modules); }
    catch (err) { fail('The tracking engine would not accept its camera pipeline: ' + msg(err)); }

    // No three.js and no window.THREE here: main.js imports three itself, and a second importer in
    // this module would be a second copy of the library with its own idea of what a Vector3 is.
    //
    // No `allowedDevices` either. The official example passes the permissive XR8.XrConfig.device().ANY
    // so a laptop can run it for development; this game only ever runs on a phone, and asking for
    // "any device" is one more thing that can send camera selection down a path meant for desktops.
    const options = { canvas: canvas };

    try {
      const started = XR8.run(options);
      // XR8.run rejects when the camera is refused. Saying so is the difference between "the game is
      // broken" and "tap the padlock and allow the camera".
      if (started && typeof started.catch === 'function') started.catch((err) => fail(msg(err)));
    } catch (err) {
      fail(msg(err));
    }
  }

  // Where the reticle should sit right now. Same hit test as place(), so the ring the player sees
  // before tapping is exactly the spot the tap will pick.
  function previewHit(nx, ny) {
    return pickHit(nx, ny);
  }

  // Commit to a spot. Waiting for NORMAL tracking is not fussiness: placing while the engine is
  // still warming up is how you get an object that slides away later.
  function place(nx, ny) {
    if (tracking !== 'NORMAL') return null;
    const pick = pickHit(nx, ny);
    if (!pick) return null;
    // Kept as plain numbers: the caller owns the scene object, and nothing in this module moves it.
    placedPos = copy(pick.position);
    placed = true;
    note('Placed on ' + pick.type + (pick.reliable ? '' : ' — a loose feature point, not a confirmed floor') + '.');
    return { position: copy(placedPos), type: pick.type, reliable: pick.reliable };
  }

  function recenter() {
    try { XR8.XrController.recenter(); }
    catch (err) { fail('Could not recentre: ' + msg(err)); }
    // Recentring re-origins the engine's world, so the old position means nothing any more.
    placedPos = null;
    placed = false;
  }

  function stop() {
    if (typeof XR8 === 'undefined' || typeof XR8.stop !== 'function') return;
    try { XR8.stop(); }
    catch (err) { fail('Could not stop the tracking engine: ' + msg(err)); }
  }

  return {
    get available() { return configured; },
    get tracking() { return tracking; },
    get reason() { return reason; },
    get label() {
      if (tracking === 'LIMITED') return 'Move the phone slowly over the floor so it can find its place.';
      if (tracking === 'NORMAL') {
        return placed ? 'Your coach is standing in the room.' : 'Tap the floor to put your coach down.';
      }
      // Anything else — no report yet, or a status this build invented — reads as "still starting".
      return 'Starting the camera…';
    },
    get placed() { return placed; },
    get position() { return placedPos ? copy(placedPos) : null; },
    configure: configure,
    start: start,
    previewHit: previewHit,
    place: place,
    recenter: recenter,
    stop: stop,
  };
}
