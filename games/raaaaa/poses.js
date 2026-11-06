// poses.js — the two stretches (overhead and side) posed procedurally on the coach rig, as per-bone
// Euler-XYZ deltas in DEGREES applied in each bone's own frame on top of the rig's bind pose.
//
// These numbers are MEASURED, not guessed, and they are specific to assets/coach/gymbro.glb. The rig
// they were solved on is a 24-bone T-posed skeleton whose bone frames do not point along +Y the way
// the old mannequin's did, so the previous table's degrees do nothing useful here. Each bone below was
// solved by pointing the limb at a world-space direction (arms up in a shallow V, torso leaned 42
// degrees, feet left in their stance) and then inverting the maths into the bone's parent frame, the
// frame coach.js applies deltas in. Every entry therefore lands its limb on the intended direction to
// within a tenth of a degree.
//
// If COACH_ASSET in tuning.js is ever pointed back at the old mannequin, THIS FILE HAS TO GO WITH IT:
// the same numbers on a different skeleton are a broken puppet, not a stretch.

// The one dial in here. The tables below are the full pose (t = 1); TUNE scales every angle in them,
// so 1 is the measured stretch, 1.1 reaches a little higher and 0.85 is a shallower one.
const TUNE = 1;

// t -> 0..1, anything non-finite (NaN, Infinity, strings, undefined, ...) becomes 0.
function clamp01(t) {
  if (typeof t !== "number" || !Number.isFinite(t)) return 0;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

// Smoothstep: eases in and out, so the pose never starts or stops abruptly.
function ease(t) {
  return t * t * (3 - 2 * t);
}

// side < 0 leans one way, everything else (0, NaN, undefined, +1, ...) leans the other way.
function sideSign(side) {
  return typeof side === "number" && Number.isFinite(side) && side < 0 ? -1 : 1;
}

// The solved full pose, per bone: [x, y, z] degrees in that bone's own frame (on top of the bind
// pose). Hips + legs only appear in the side stretch, where the pelvis carries the lean and the legs
// are held in the stance they were standing in so the feet stay on the floor.
const SOLVED = {
  overhead: {
    Spine: [-15.8, -0.1, 5.4], // opens the chest into a small arch
    Head: [-5.8, -1, 6.5], // chin up a touch
    LeftArm: [0.2, -24.6, 99.4], // the shoulder/upper arm: out of the T-pose and up
    RightArm: [1.4, 11, -107.6], // Z is the shoulder's raise, Y its roll, X a little forward
    LeftForeArm: [-1.9, -2.6, -6.1], // a few degrees of elbow, so the arms are not ramrods
    RightForeArm: [-9.6, 5.9, 17.9],
  },
  // Leaning toward his own left (+X). The numbers are not mirror images of each other: the rig is
  // not perfectly symmetric and each side was solved on its own.
  "side+": {
    Hips: [5.6, -0.9, -11.7],
    LeftUpLeg: [-24.6, -2.2, -0.6], // both legs counter the pelvis, so the feet do not skate
    LeftLeg: [15.7, -6.8, -23.8],
    RightUpLeg: [13.6, -2.3, -4.9],
    RightLeg: [2.7, -3.5, -25.2],
    Spine02: [-0.3, -0.6, -7.9], // the lean curving up the spine: 12 -> 20 -> 30 -> 42 degrees
    Spine01: [-0.5, -0.9, -10],
    Spine: [-0.9, -0.9, -11.4],
    Head: [-5.4, 0.8, 29.3], // counter-tilted, so he keeps looking down the phone
    LeftArm: [13.7, -21.4, 114.1],
    RightArm: [-14.7, 19.2, -85.2],
    LeftForeArm: [-4.9, -3.5, -9.7],
    RightForeArm: [-9, 5.3, 15.6],
  },
  "side-": {
    Hips: [6.2, -0.8, 12.4],
    LeftUpLeg: [-25.4, -10, 20.2],
    LeftLeg: [17.5, -6.5, -21.4],
    RightUpLeg: [14.1, 3.6, 18.9],
    RightLeg: [3.6, -3.7, -24.6],
    Spine02: [0.1, 0.7, 8],
    Spine01: [-0.2, 1.1, 10],
    Spine: [-0.2, 1.4, 12.5],
    Head: [-6.6, 3.5, -18.9],
    LeftArm: [1.9, -13.8, 87.9],
    RightArm: [-47.9, 36.7, -84.9],
    LeftForeArm: [-6.7, -4.3, -12.9],
    RightForeArm: [-9.9, 7.1, 22.5],
  },
};

// The table scaled from full pose down to s, in a fresh object each call (coach.js reads it and
// throws it away, so nothing here may be mutated by two callers at once).
function scaled(table, s) {
  const out = {};
  const k = s * TUNE;
  for (const bone in table) {
    const a = table[bone];
    out[bone] = [a[0] * k, a[1] * k, a[2] * k];
  }
  return out;
}

// t = 0 is rest, t = 1 is the full "reach up nice and tall".
export function overheadStretch(t) {
  const s = ease(clamp01(t));
  if (s <= 0) return {};
  return scaled(SOLVED.overhead, s);
}

// The same reach overhead, with the whole body leaning over to one side.
export function sideStretch(t, side) {
  const s = ease(clamp01(t));
  if (s <= 0) return {};
  return scaled(sideSign(side) < 0 ? SOLVED["side-"] : SOLVED["side+"], s);
}

// Names of the poses this module can produce.
export function poseNames() {
  return ["overheadStretch", "sideStretch"];
}
