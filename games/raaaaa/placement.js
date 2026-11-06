// placement.js — where the coach stands, and how he stays there. With the 8th Wall world-tracking
// engine he stands at a real spot in the room and stays in it. With the phone's rotation sensors
// alone he is only pinned to a direction, so turning works and walking does not. Without a camera at
// all he simply stands in front of the lens. Three modes, and the label says which one is running.

import * as THREE from 'three';
import * as T from 'jam/tuning';

const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);

// How tall the coach is with both arms stretched overhead. This, not his standing height, is what
// the framing is built around: he spends the whole interesting part of the workout reaching up, and
// a frame sized for the standing figure throws his hands off the top of the screen the moment the
// stretch begins. The numbers themselves live in tuning.js, because they are what a maker would
// want to turn if he looks too small or too high.
const REACH_M = Number(T.PLACE_REACH_M) || 2.45;
const FILL = clamp(Number(T.PLACE_FILL), 0.3, 1.2, 0.76);
const MIN_M = clamp(Number(T.PLACE_MIN_M), 0.5, 50, 2.5);
const MAX_M = clamp(Number(T.PLACE_MAX_M), MIN_M, 100, 11);

// How big he stands. The engine's world is in metres, so this is a real height in the room rather than
// a number that happens to look right: at 0.4 he is about 70 cm tall, standing on the actual floor.
// The pinch gesture moves it, so the value in tuning.js is where a fresh session starts.
const SCALE_MIN = clamp(Number(T.COACH_SCALE_MIN), 0.01, 10, 0.12);
const SCALE_MAX = clamp(Number(T.COACH_SCALE_MAX), SCALE_MIN, 10, 1.5);
const SCALE_START = clamp(Number(T.COACH_SCALE), SCALE_MIN, SCALE_MAX, 0.4);

function clamp(value, lo, hi, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return value < lo ? lo : value > hi ? hi : value;
}

export function createPlacement(options) {
  const opts = options || {};
  const orientation = opts.orientation || null;
  const say = (text) => {
    try { if (typeof opts.onNote === 'function') opts.onNote(text); } catch (e) { /* not ours */ }
  };

  // Where the coach's anchor spot sits in the camera's own frame, worked out once from SPOT. The
  // model is authored in metres with its feet on y = 0, so this is also, literally, where his feet
  // are: everything below the feet is floor.
  const anchorPos = new THREE.Vector3();
  const room = new Float64Array(9);       // the room -> phone transform, refilled every frame
  const mat = new THREE.Matrix4();        // the same thing as something three.js can use
  const quat = new THREE.Quaternion();

  let mode = 'camera';                    // 'ar' with the engine, 'camera' with the rotation
                                          // sensors only, 'preview' with no camera at all
  let placed = false;                     // the player has put him down somewhere
  let hfovTan = Math.tan(0.5 * (Number(T.ORIENT_HFOV_DEG) || 60) * DEG);

  // ---- the AR anchor: one spot in the room, and it never moves ---------------------------------
  // This is the whole difference between real anchoring and the rotation-only trick further down.
  // The position below is in the ENGINE's world coordinates, it is written once when the player taps,
  // and after that nothing here reads the camera. If the player walks, the camera moves and the coach
  // does not. That is what it means for something to be anchored in a room.
  const worldPos = new THREE.Vector3();
  const worldQuat = new THREE.Quaternion();
  let worldPlaced = false;
  let worldScale = SCALE_START; // his size in the room, changed by the pinch gesture, not per frame

  // Fit the camera to the canvas. The phone's own lens is not knowable from inside a web page, so
  // the field of view is the assumed one from tuning.js — if the coach looks stretched or tiny, that
  // is the number to change. three.js wants a VERTICAL field of view, and the assumed one is
  // horizontal, so the aspect is what converts between them.
  function frame(aspect) {
    const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
    const hfov = (Number(T.ORIENT_HFOV_DEG) || 60) * DEG;
    hfovTan = Math.tan(hfov / 2);
    const vfov = 2 * Math.atan(hfovTan / a);
    return { fovDeg: vfov / DEG, aspect: a };
  }

  // Put the coach's anchor spot into camera space. Recomputed every frame, because the aspect
  // changes when the phone is turned sideways or the window is resized, and the framing has to
  // follow it. The model's feet are on its own y = 0, so this is where his feet are: everything
  // below is floor.
  //
  // Two things are worked out here, and neither is a fixed number:
  //   1. How far away he has to stand for his outstretched reach to take up FILL of the screen's
  //      height. A tall screen is a narrow one, so the same figure fills more of it and he has to
  //      step back; a wide screen lets him come closer. That is what makes this work in portrait
  //      as well as landscape, with no special case for either.
  //   2. Where to put his feet so the stretch is centred: his feet go half a reach below the middle
  //      of the screen, which puts the top of his reach the same distance above it. Note that this
  //      falls out as simply -REACH_M/2, the aspect cancels — but it is written out in full because
  //      the cancellation is a result, not the intent.
  function placeAnchor(aspect) {
    const tanV = hfovTan / aspect;
    let distance = REACH_M / (2 * FILL * tanV); // so that REACH_M spans FILL of the height
    distance = clamp(distance, MIN_M, MAX_M, 5);
    const span = REACH_M / (2 * distance * tanV); // the share of the height his reach now covers
    const vFeet = 0.5 + span / 2; // v counts downward from the top, so bigger is lower
    const y = (0.5 - vFeet) * 2 * distance * tanV;
    anchorPos.set(0, y, -distance);
  }

  function setMode(next) {
    mode = next === 'preview' ? 'preview' : next === 'ar' ? 'ar' : 'camera';
  }

  // The player has tapped a real floor position, and the engine gave us its world coordinates. That
  // position is now the coach's, full stop. `yaw` is worked out once by the caller so that he is
  // facing whoever put him down, and frozen with the position: a fixed direction in the room, not a
  // direction that follows the phone.
  function setWorldPlacement(position, yaw) {
    if (!position) return false;
    const x = Number(position.x), y = Number(position.y), z = Number(position.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
    worldPos.set(x, y, z);
    worldQuat.setFromAxisAngle(UP, Number.isFinite(yaw) ? yaw : 0);
    worldPlaced = true;
    placed = true;
    say('He is standing in your room now — walk around him and watch him stay put.');
    return true;
  }

  // Drop the anchor so the player can put him down somewhere else.
  function clearWorldPlacement() {
    worldPlaced = false;
    placed = false;
  }

  // His size in the room. Clamped here rather than at the gesture, so every caller gets the same
  // limits and nobody can pinch him down to nothing or up into a giant. Returns the size it settled
  // on, which is what the caller should report to the player.
  function setScale(value) {
    const next = Number(value);
    if (Number.isFinite(next)) worldScale = next < SCALE_MIN ? SCALE_MIN : next > SCALE_MAX ? SCALE_MAX : next;
    return worldScale;
  }

  function place() {
    placed = true;
    recenter();
    return true;
  }

  // Take the phone's current aim as the coach's direction. With no sensors this is a no-op, which
  // is exactly the preview case: he stays centred in front of the lens.
  function recenter() {
    if (mode === 'ar') {
      // A world anchor is not something you re-aim; you put it down again. So the Move coach button
      // lifts him and waits for the next tap.
      clearWorldPlacement();
      say('Tap the floor where you want him to stand.');
      return;
    }
    if (orientation) {
      try { orientation.anchor(); } catch (err) { /* a broken sensor must not stop the game */ }
    }
    say(mode === 'preview' ? 'The coach is in front of you.' : 'The coach is back in front of you.');
  }

  // Called every frame. `aspect` is the canvas width/height, so the camera and the anchor spot
  // follow a phone that has been turned sideways or a window that has been resized.
  function update(coachRoot, aspect) {
    if (!coachRoot) return;
    const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;

    // The AR path. The engine owns the camera, so there is no anchor arithmetic to do and nothing to
    // recompute: either he has a spot in the room, in which case he is put there and left there, or
    // he has not been placed yet and is hidden until there is a floor to stand him on.
    if (mode === 'ar') {
      // Size is a property of the anchor, like its position: set here from one number, never derived
      // from the distance between the phone and the coach. Scaling the root scales him about his own
      // feet, which are on the root's origin, so he grows and shrinks standing on the same spot.
      coachRoot.scale.setScalar(worldScale);
      if (worldPlaced) {
        coachRoot.position.copy(worldPos);
        coachRoot.quaternion.copy(worldQuat);
        coachRoot.visible = true;
      } else {
        coachRoot.visible = false;
      }
      return;
    }

    // Outside AR there is no real room to be a particular height in, and the framing below is worked
    // out for the model's own size, so here he is simply his real size. A pinch in AR must not leave
    // him pocket-sized if the engine then goes away.
    coachRoot.scale.setScalar(1);

    placeAnchor(a);

    // The room -> phone transform. Null means "no sensors, or nothing to anchor to", and then the
    // coach simply stands in front of the phone: the identity case, with no special-casing.
    let haveRoom = false;
    if (orientation && orientation.anchored) {
      try { haveRoom = !!orientation.roomMatrix(room); } catch (err) { haveRoom = false; }
    }

    if (!haveRoom) {
      coachRoot.position.copy(anchorPos);
      coachRoot.quaternion.identity();
      return;
    }

    // One matrix does both jobs, which is what makes this the honest version of the trick: it moves
    // the coach to where his spot now appears, AND turns him to face the way the room does. Turn the
    // phone and you see his side, the way you would see the side of a person standing in the room.
    //
    // The catch is that this is rotation only. The sensors cannot tell that the player has walked
    // across the room, so the coach cannot stay on his patch of floor if they do. Turning is real;
    // walking is not, and nothing here pretends otherwise.
    const r = room;
    mat.set(
      r[0], r[1], r[2], 0,
      r[3], r[4], r[5], 0,
      r[6], r[7], r[8], 0,
      0, 0, 0, 1,
    );
    quat.setFromRotationMatrix(mat);
    coachRoot.quaternion.copy(quat);
    coachRoot.position.copy(anchorPos).applyQuaternion(quat);
  }

  return {
    frame,
    place,
    recenter,
    update,
    setMode,
    setWorldPlacement,
    clearWorldPlacement,
    setScale,
    get mode() { return mode; },
    get placed() { return placed; },
    get worldPlaced() { return worldPlaced; },
    get scale() { return worldScale; },
    get worldPosition() { return worldPlaced ? worldPos : null; },
    // An honest label for the debug line: the three modes are not the same thing and the screen
    // should not let anyone think they are.
    get label() {
      if (mode === 'ar') return worldPlaced ? 'AR · standing in the room' : 'AR · waiting for the floor';
      if (mode === 'preview') return 'preview · no camera';
      if (orientation && orientation.tracking) return 'camera · turn to look around';
      return 'camera · fixed view';
    },
  };
}
