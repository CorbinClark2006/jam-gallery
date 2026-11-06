// orientation.js — keeps a spot on the wall fixed as the phone turns: it remembers where a screen point was looking when the wall was anchored, and re-draws that same spot on screen now.

// Honest limits: this is ROTATION ONLY. The rotation sensors carry no distance and no sideways
// movement, so it is not 6DoF SLAM — if the player walks, the bug cannot stay on its wall spot. The
// field of view is ASSUMED too (browsers do not expose the real lens), so a phone whose lens is much
// wider or narrower than ORIENT_HFOV_DEG drifts as it turns.

import * as T from 'jam/tuning';

const DEG = Math.PI / 180;
// A device-frame ray with z at or above this points behind (or level with) the camera: no screen spot.
const BEHIND = 1e-4;

// NOT async, on purpose: it hands back a plain object straight away, so the start button's click
// handler can call enable() synchronously inside the tap. iOS raises its motion permission prompt
// only from a real user gesture, and an await before enable() can lose it.
export function loadOrientation(onStatus) {
  // `window` where there is one — a browser, or the test stub — and globalThis otherwise.
  const root = (typeof window !== 'undefined' && window) || globalThis;

  // Tunables, read once and clamped, so one silly value cannot poison every answer.
  const hfovTan = Math.tan(0.5 * T.ORIENT_HFOV_DEG * DEG) || Math.tan(30 * DEG);
  const smooth = clamp(T.ORIENT_SMOOTH, 0, 1, 1); // 1 = snap to each reading, 0 = never move
  const jumpLimit = clamp(T.ORIENT_MAX_JUMP_DEG, 0, 360, 180);
  const staleMs = clamp(T.ORIENT_STALE_MS, 1, 600000, 1200);

  // q is the smoothed rotation as a quaternion (x, y, z, w). R0 is the anchor's rotation as a
  // row-major 3x3 matrix (anchor device frame -> world). Both describe the camera, which faces -Z.
  const q = [0, 0, 0, 1];
  const R0 = new Float64Array(9);
  let attached = false;  // our listener is on
  let anchored = false;  // we hold a reference frame
  let lostFlag = false;  // the stale timer has fired
  let haveReading = false;
  let lastReadAt = 0;    // ms of the last usable reading; 0 means none yet
  let staleTimer = 0;

  // Scratch work, reused everywhere so the per-frame path allocates nothing.
  const qa = [0, 0, 0, 1], qb = [0, 0, 0, 1], qc = [0, 0, 0, 1], q2 = [0, 0, 0, 1], qNew = [0, 0, 0, 1];
  const v0 = [0, 0, 0], vw = [0, 0, 0], vn = [0, 0, 0];
  const mNow = new Float64Array(9);
  const out = { u: 0, v: 0 }; // project()'s result — the SAME object each call, so read it at once

  const say = (text) => {
    try { if (typeof onStatus === 'function') onStatus(text); } catch (e) { /* a bad callback is not ours */ }
  };

  // ---- the sensor reading, turned into a rotation --------------------------------------------

  function onReading(event) {
    if (!attached) return;
    const alphaRaw = event && event.alpha;
    const beta = event && event.beta;
    const gamma = event && event.gamma;
    // No pitch or roll means nothing usable. Phones without a compass report alpha as null, which
    // only costs the left/right turn, so treat that as 0 rather than throw the reading away.
    if (!isNum(beta) || !isNum(gamma)) return;
    const alpha = isNum(alphaRaw) ? alphaRaw : 0;

    // W3C convention, intrinsic Z-X'-Y'': R = Rz(alpha) * Rx(beta) * Ry(gamma). Built here as the
    // quaternion qz * qx * qy, which is the same rotation and far easier to ease smoothly, then
    // corrected for the screen orientation by a turn about the device's own Z, with the sign the
    // well-known three.js DeviceOrientationControls uses for that step. Upright (angle 0) it is the
    // identity, which is where the makers will play; in landscape, if the bug swings the wrong way
    // as the phone turns, this one sign is what needs flipping — worth checking on a real phone.
    axisQ(qa, 0, 0, 1, alpha * DEG * 0.5);    // Rz(alpha)
    axisQ(qb, 1, 0, 0, beta * DEG * 0.5);     // Rx(beta)
    mulQ(q2, qa, qb);
    axisQ(qc, 0, 1, 0, gamma * DEG * 0.5);    // Ry(gamma)
    mulQ(qa, q2, qc);
    axisQ(qc, 0, 0, 1, -screenAngleDeg() * DEG * 0.5);
    mulQ(qNew, qa, qc);
    normQ(qNew);

    if (haveReading) {
      // A reading far from what we are showing is a sensor glitch: drop it whole, so one bad frame
      // cannot fling the bug across the room. The yardstick is the smoothed value, as specified.
      if (angleDeg(q, qNew) > jumpLimit) return;
      lerpQ(q, qNew, smooth);                 // ease toward the reading rather than snap to it
    } else {
      for (let i = 0; i < 4; i++) q[i] = qNew[i]; // the first reading is taken as-is: nothing to ease from
      haveReading = true;
    }

    lastReadAt = Date.now();
    lostFlag = false;
    armStale();
  }

  function armStale() {
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = setTimeout(onStale, staleMs + 50);
  }

  function onStale() {
    staleTimer = 0;
    if (!attached || !anchored) return; // never tracking, so nothing to lose
    lostFlag = true;
    say('Lost the motion sensors — the bug will hold still.');
  }

  function screenAngleDeg() {
    try {
      const so = root.screen && root.screen.orientation;
      if (so && isNum(so.angle)) return so.angle;
      if (isNum(root.orientation)) return root.orientation; // the old window.orientation
    } catch (e) { /* fall through to the default */ }
    return 0;
  }

  // ---- screen point <-> ray ------------------------------------------------------------------

  // tan(vfov/2) = tan(hfov/2) / aspect. Read live, so a resize (or turning the phone) is picked up.
  function vfovTan() {
    const w = root.innerWidth;
    const h = root.innerHeight;
    const aspect = (isNum(w) && isNum(h) && w > 0 && h > 0) ? w / h : 1;
    return hfovTan / aspect;
  }

  // Screen point -> unit ray in the frame it belongs to. Writes into `dest`, never allocates.
  function rayForUV(dest, u, v) {
    const tH = hfovTan;
    const tV = vfovTan();
    const xn = (u - 0.5) * 2 * tH;
    const yn = -(v - 0.5) * 2 * tV;
    const len = Math.sqrt(xn * xn + yn * yn + 1);
    dest[0] = xn / len;
    dest[1] = yn / len;
    dest[2] = -1 / len;
    return dest;
  }

  // Unit ray in the current device frame -> screen point. null when the ray is behind the camera.
  function uvForRay(r) {
    if (r[2] >= -BEHIND) return null;
    const u = 0.5 + (r[0] / -r[2]) / (2 * hfovTan);
    const v = 0.5 - (r[1] / -r[2]) / (2 * vfovTan());
    if (!isNum(u) || !isNum(v)) return null; // belt and braces: never hand back a NaN
    out.u = u;
    out.v = v;
    return out;
  }

  // Reproject a point given in the ANCHOR's screen frame into the screen frame we are in now.
  function project(u, v) {
    if (!anchored || !isNum(u) || !isNum(v)) return null;
    rayForUV(v0, u, v);           // anchor frame
    matVec(vw, R0, v0);           // -> world
    quatToMat(mNow, q);
    matTVec(vn, mNow, vw);        // world -> current device frame
    return uvForRay(vn);
  }

  // Reproject a whole thing, not just a screen point: this is the transform that carries anything
  // fixed in the room into the phone's frame as it is held right now. project() works out the same
  // thing for a single screen point; this hands over the entire rotation, so a 3D object can be
  // both MOVED and TURNED by it — turn the phone and you walk around it. It is RwT * R0, written
  // into the caller's array as 9 row-major numbers. Returns null when there is nothing to anchor to.
  function roomMatrix(dest) {
    if (!dest || !anchored || !haveReading) return null;
    quatToMat(mNow, q); // Rw: the phone's frame now -> the room
    for (let r = 0; r < 3; r++) {
      const a = mNow[r], b = mNow[3 + r], c = mNow[6 + r]; // column r of RwT, as a row
      for (let col = 0; col < 3; col++) {
        dest[r * 3 + col] = a * R0[col * 3] + b * R0[col * 3 + 1] + c * R0[col * 3 + 2];
      }
    }
    return dest;
  }

  // ---- the small public surface --------------------------------------------------------------

  function anchor() {
    // Before the first reading, q is still the identity: anchoring to it would pin the wall to a
    // rotation the phone has never been in, and the bug would jump when the first reading arrived.
    // Until there is a reading, this reports false and project() keeps handing back null.
    if (!haveReading) return false;
    const first = !anchored;
    quatToMat(R0, q);             // the current smoothed rotation becomes the reference frame
    anchored = true;
    // Only the first anchor is worth saying: main.js re-anchors on every AI look, about once a
    // second, and a status line that repeats every second is noise.
    if (first) say('Anchored to the wall.');
    return true;
  }

  function clear() {
    anchored = false;
  }

  function stop() {
    if (staleTimer) { clearTimeout(staleTimer); staleTimer = 0; }
    if (attached) {
      try { root.removeEventListener('deviceorientation', onReading); } catch (e) { /* already gone */ }
    }
    attached = false;
  }

  async function enable() {
    if (!T.ORIENT_TRACKING) { say('Motion tracking is switched off.'); return false; }
    if (attached) return true;
    try {
      const DOE = root.DeviceOrientationEvent;
      if (typeof DOE === 'undefined' || DOE === null) {
        say('No motion sensors here — the bug stays put on screen.');
        return false;
      }
      // iOS 13+ hides the sensors behind a permission prompt, and only a user gesture may open it.
      if (typeof DOE.requestPermission === 'function') {
        let answer = null;
        try { answer = await DOE.requestPermission(); } catch (e) { answer = null; }
        if (answer !== 'granted') {
          say('Motion access was refused — the bug stays put on screen.');
          return false;
        }
      }
      root.addEventListener('deviceorientation', onReading);
      attached = true;
      say('Motion tracking is on.');
      return true;
    } catch (e) {
      return false; // enable() must never reject, whatever the platform throws at us
    }
  }

  return {
    enable,
    get tracking() {
      return attached && anchored && lastReadAt !== 0 && (Date.now() - lastReadAt) < staleMs;
    },
    get device() {
      return attached ? 'deviceorientation' : 'none';
    },
    get lost() {
      if (!attached || !anchored) return false;
      if (lostFlag) return true;
      return lastReadAt !== 0 && (Date.now() - lastReadAt) >= staleMs;
    },
    get anchored() { return anchored; },
    anchor,
    project,
    roomMatrix,
    clear,
    stop,
  };
}

// ---- helpers: plain numbers, written into the caller's array so nothing here allocates ---------

function clamp(value, lo, hi, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n < lo ? lo : n > hi ? hi : n;
}

function isNum(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

// Quaternion for a rotation of `half` radians about the given axis.
function axisQ(dest, x, y, z, half) {
  const s = Math.sin(half);
  dest[0] = x * s;
  dest[1] = y * s;
  dest[2] = z * s;
  dest[3] = Math.cos(half);
  return dest;
}

// dest = a * b, meaning "the rotation b, then the rotation a".
function mulQ(dest, a, b) {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  const bx = b[0], by = b[1], bz = b[2], bw = b[3];
  dest[0] = aw * bx + ax * bw + ay * bz - az * by;
  dest[1] = aw * by - ax * bz + ay * bw + az * bx;
  dest[2] = aw * bz + ax * by - ay * bx + az * bw;
  dest[3] = aw * bw - ax * bx - ay * by - az * bz;
  return dest;
}

function normQ(a) {
  const len = Math.hypot(a[0], a[1], a[2], a[3]) || 1;
  a[0] /= len; a[1] /= len; a[2] /= len; a[3] /= len;
  return a;
}

// Move `cur` the fraction t of the way to `target`, the short way round, and renormalise.
function lerpQ(cur, target, t) {
  const d = cur[0] * target[0] + cur[1] * target[1] + cur[2] * target[2] + cur[3] * target[3];
  const sign = d < 0 ? -1 : 1; // q and -q are the same rotation, so take the short way
  for (let i = 0; i < 4; i++) cur[i] += t * (sign * target[i] - cur[i]);
  return normQ(cur);
}

// Difference between two rotations, in degrees, ignoring which way round the quaternion is.
function angleDeg(a, b) {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  if (d >= 1) return 0;
  return 2 * Math.acos(d) / DEG;
}

// Quaternion -> row-major 3x3 rotation matrix.
function quatToMat(m, a) {
  const x = a[0], y = a[1], z = a[2], w = a[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  m[0] = 1 - (yy + zz); m[1] = xy - wz;       m[2] = xz + wy;
  m[3] = xy + wz;       m[4] = 1 - (xx + zz); m[5] = yz - wx;
  m[6] = xz - wy;       m[7] = yz + wx;       m[8] = 1 - (xx + yy);
  return m;
}

// m * v
function matVec(dest, m, v) {
  const x = v[0], y = v[1], z = v[2];
  dest[0] = m[0] * x + m[1] * y + m[2] * z;
  dest[1] = m[3] * x + m[4] * y + m[5] * z;
  dest[2] = m[6] * x + m[7] * y + m[8] * z;
  return dest;
}

// m transposed * v
function matTVec(dest, m, v) {
  const x = v[0], y = v[1], z = v[2];
  dest[0] = m[0] * x + m[3] * y + m[6] * z;
  dest[1] = m[1] * x + m[4] * y + m[7] * z;
  dest[2] = m[2] * x + m[5] * y + m[8] * z;
  return dest;
}
