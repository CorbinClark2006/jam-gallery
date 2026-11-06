// coach.js — loads the coach's model and moves him: playing the pack's animation clips, cross-fading
// between them, and posing the two stretches by hand because the pack has no stretching clips at all.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as T from 'jam/tuning';
import { overheadStretch, sideStretch } from 'jam/poses';

const DEG = Math.PI / 180;

// Semantic action -> the REAL clip name inside the pack, and whether it loops.
// Every one of these names was read out of assets/coach/gymbro.glb's own JSON chunk, not guessed.
// That file ships exactly ten clips, all on the same 24-bone skeleton: Idle, Big_Wave_Hello,
// Cheer_with_Both_Hands_Up, Victory_Cheer, Confused_Scratch, Angry_Stomp, Shrug, FunnyDancing_01,
// Jazz_Hands and Grip_and_Throw_Down. There is NO stretching clip and NO talking clip, which is why
// the two stretches are posed in poses.js and why `talking` borrows the idle.
//
// Everything loops, including the one-shots. A looping clip cannot end on a held frame, so there is
// no state in which the mixer stops writing to the bones and the rig falls back to its bind pose —
// which on this model is a T-pose. That is the whole reason none of these is a one-shot.
const ACTIONS = {
  idle: { clip: 'Idle', loop: true },
  talking: { clip: 'Idle', loop: true }, // no talking clip in this pack: he breathes instead
  wave: { clip: 'Big_Wave_Hello', loop: true },
  cheer: { clip: 'Cheer_with_Both_Hands_Up', loop: true },
  victory: { clip: 'Victory_Cheer', loop: true },
  // This pack has no sit, sit-down or stand-up clip at all (the previous one did). They are named
  // here, pointed at the idle, so that any caller asking for them gets a live pose rather than a
  // frozen one — see the standing-start note in main.js.
  seatedIdle: { clip: 'Idle', loop: true },
  sitDown: { clip: 'Idle', loop: true },
  standUp: { clip: 'Idle', loop: true },
};

// The bones the two stretches touch. A name here that poses.js has no angles for is simply skipped,
// so this list only has to be a superset of what the poses use. It is the spine chain (the side
// stretch leans the whole torso over), both arms and forearms, the head, and the hips plus both legs
// — the side stretch carries the pelvis over and holds the legs in their stance so the feet stay put.
const POSE_BONES = [
  'Hips', 'Spine02', 'Spine01', 'Spine', 'Head',
  'LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm',
  'LeftUpLeg', 'LeftLeg', 'RightUpLeg', 'RightLeg',
];

export async function loadCoach(onStatus) {
  const say = (text) => {
    try { if (typeof onStatus === 'function') onStatus(text); } catch (e) { /* not ours to fix */ }
  };

  const url = T.COACH_ASSET;
  say('Fetching the coach…');

  let gltf = null;
  try {
    gltf = await new Promise((resolve, reject) => {
      new GLTFLoader().load(url, resolve, undefined, (err) => {
        reject(new Error('could not read ' + url + (err && err.message ? ' (' + err.message + ')' : '')));
      });
    });
  } catch (err) {
    // A missing or broken model must not leave the player with a blank screen: the workout still
    // runs, with the voice and the captions, over a plain stand-in figure.
    return standInCoach(err && err.message ? err.message : String(err));
  }

  return buildCoach(gltf, say);
}

function buildCoach(gltf, say) {
  const root = new THREE.Group();
  root.name = 'coach';

  const model = gltf.scene;
  // The mannequin is authored in metres with its feet on y = 0, so it drops straight onto a floor
  // and needs no scaling. COACH_HEIGHT_M is kept so the AR placement can sanity-check that.
  root.add(model);
  model.rotation.y = (T.COACH_TURN_DEG || 0) * DEG;

  // This model is one skinned mesh with ONE material: a 128 KB JPEG painted all over it, no normal
  // map and no metalness map. The file's own sampler asks for plain linear filtering with mipmaps,
  // and its metallicFactor is 0, so three.js renders it as flat painted surfaces with nothing to fix
  // up. (The model it replaced shipped a 512x512 atlas that had to be forced to nearest-neighbour to
  // keep its look; that override is gone, because on this file it would only make the art crawl.)
  model.traverse((node) => {
    if (!node.isMesh && !node.isSkinnedMesh) return;
    node.frustumCulled = false; // a skinned mesh's bounds lie once the pose moves it
  });

  // Find the bones by name, and remember the pose the file shipped them in. That rest pose is a
  // T-pose, and it is what the hand-made stretches are measured from.
  const bones = Object.create(null);
  const rest = Object.create(null);
  model.traverse((node) => {
    if (!node.isBone) return;
    bones[node.name] = node;
    rest[node.name] = node.quaternion.clone();
  });

  const found = Object.keys(bones);
  const clips = gltf.animations || [];

  // Wire up the mixer. A semantic action whose clip is missing from the file falls back to idle
  // rather than throwing, and the caller can read `missing` to see exactly what was not found.
  const mixer = new THREE.AnimationMixer(model);
  const actions = Object.create(null);
  const missing = [];
  const byName = new Map(clips.map((c) => [c.name, c]));

  for (const [name, spec] of Object.entries(ACTIONS)) {
    const clip = byName.get(spec.clip);
    if (!clip) { missing.push(spec.clip); continue; }
    const action = mixer.clipAction(clip);
    action.loop = spec.loop ? THREE.LoopRepeat : THREE.LoopOnce;
    action.clampWhenFinished = !spec.loop; // a one-shot holds its last frame instead of snapping back
    actions[name] = action;
  }

  // Where the coach is standing and which way he is facing is the placement layer's business; this
  // is just the current clip, the current hand-made pose, and the blend between them.
  let current = null;               // the action we are playing
  let currentName = '';
  const poseQuat = Object.create(null); // scratch: the target local rotation per bone, reused
  for (const name of POSE_BONES) poseQuat[name] = new THREE.Quaternion();

  const euler = new THREE.Euler(0, 0, 0, 'XYZ');
  let poseName = '';   // '' means no hand-made pose: the clip plays untouched
  let poseT = 0;       // how far into the stretch, 0..1, as the pose's own maths wants it
  let poseSide = 1;
  let poseWeight = 0;  // 0 = the clip alone, 1 = the hand-made pose alone. Ramps over COACH_FADE.

  const fade = Math.max(0.01, Number(T.COACH_FADE) || 0.35);

  function play(name) {
    const next = actions[name];
    if (next === current) return true;
    if (!next) {
      // No such action. Keep whatever is playing rather than freezing mid-pose.
      say('No clip for "' + name + '".');
      return false;
    }
    if (current) {
      // Cross-fading is what stops the T-pose flashing between two clips: both are on the mixer
      // at once for the length of the fade, and their weights cross over.
      next.reset();
      next.setEffectiveWeight(1);
      next.crossFadeFrom(current, fade, false);
      next.play();
    } else {
      next.reset().setEffectiveWeight(1).fadeIn(fade).play();
    }
    current = next;
    currentName = name;
    return true;
  }

  // Start a hand-made stretch, or pass null to fade back to whatever clip is playing.
  function setStretch(name, t, side) {
    poseName = name || '';
    if (Number.isFinite(t)) poseT = t < 0 ? 0 : t > 1 ? 1 : t;
    if (Number.isFinite(side) && side !== 0) poseSide = side < 0 ? -1 : 1;
  }

  // The hand-made pose for this frame, as local-frame rotations per bone. Never throws: a pose
  // module that misbehaves just means the clip plays untouched.
  function poseTable() {
    if (!poseName) return null;
    try {
      if (poseName === 'overhead') return overheadStretch(poseT);
      if (poseName === 'side') return sideStretch(poseT, poseSide);
    } catch (err) {
      poseName = '';
    }
    return null;
  }

  function update(dt) {
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 0;
    mixer.update(step);

    // Ramp the hand-made pose's share in or out. Eased, so it never snaps into position.
    const target = poseName ? 1 : 0;
    if (poseWeight !== target) {
      const k = 1 - Math.exp(-(step / fade) * 3);
      poseWeight += (target - poseWeight) * k;
      if (Math.abs(poseWeight - target) < 0.002) poseWeight = target;
    }
    if (poseWeight <= 0.001) return; // nothing to add: the clip alone is playing

    const table = poseTable();
    if (!table) return;

    // Applied AFTER the mixer has written this frame's clip pose, and by slerping the bone toward
    // the target rather than assigning it: at full weight the bone lands exactly on the stretch, at
    // part weight it is a blend between the clip and the stretch. That blend is the whole trick —
    // it is why there is no jump and no T-pose when a stretch starts or stops.
    for (const name of POSE_BONES) {
      const bone = bones[name];
      const angles = table[name];
      if (!bone || !angles) continue;
      const restQ = rest[name];
      const x = Number(angles[0]), y = Number(angles[1]), z = Number(angles[2]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      euler.set(x * DEG, y * DEG, z * DEG);
      const q = poseQuat[name];
      q.setFromEuler(euler);
      q.premultiply(restQ); // the pose is a delta in the bone's own frame, on top of its rest pose
      bone.quaternion.slerp(q, poseWeight);
    }
  }

  function dispose() {
    mixer.stopAllAction();
    root.traverse((node) => {
      if (node.isMesh || node.isSkinnedMesh) {
        node.geometry && node.geometry.dispose && node.geometry.dispose();
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        for (const mat of materials) {
          if (!mat) continue;
          if (mat.map) mat.map.dispose && mat.map.dispose();
          mat.dispose && mat.dispose();
        }
      }
    });
  }

  return {
    object3D: root,
    fallback: false,
    reason: '',
    clips: clips.map((c) => c.name), // the REAL names, for the debug line and the devlog
    bones: found,
    missing,
    height: Number(T.COACH_HEIGHT_M) || 1.9,
    play,
    setStretch,
    update,
    dispose,
    get playing() { return currentName; },
    get stretching() { return poseName; },
    // Debug readouts, for the ?fps pane and for checking a stretch against the skeleton it lands on:
    // poseT is how far into the stretch the pose module was asked to go, poseWeight how much of the
    // hand-made pose is actually on the bones (0 = the clip alone, 1 = the pose alone).
    get poseT() { return poseT; },
    get poseWeight() { return poseWeight; },
    get hasSkeleton() { return found.length > 0; },
    set turn(deg) { model.rotation.y = (Number(deg) || 0) * DEG; },
    get turn() { return model.rotation.y / DEG; },
  };
}

// A plain figure for when the model cannot be fetched at all, so the workout still has someone to
// follow. It has no skeleton, so clips and stretches quietly do nothing.
function standInCoach(reason) {
  const root = new THREE.Group();
  root.name = 'coach-fallback';

  const skin = new THREE.MeshStandardMaterial({ color: 0xf0c9a0, roughness: 0.8 });
  const cloth = new THREE.MeshStandardMaterial({ color: 0x4a7ec7, roughness: 0.9 });

  const capsule = (radius, length, material, y) => {
    const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, length, 4, 12), material);
    mesh.position.y = y;
    root.add(mesh);
    return mesh;
  };

  capsule(0.16, 0.42, cloth, 1.06); // torso
  capsule(0.115, 0.14, skin, 1.5);  // head
  const left = capsule(0.06, 0.34, skin, 1.02);
  left.position.x = -0.24;
  const right = capsule(0.06, 0.34, skin, 1.02);
  right.position.x = 0.24;
  const legs = capsule(0.085, 0.42, cloth, 0.5); // both legs as one, which is all a stand-in needs
  legs.scale.x = 1.45;

  return {
    object3D: root,
    fallback: true,
    reason: reason || 'the coach model could not be loaded',
    clips: [],
    bones: [],
    missing: [],
    height: 1.9,
    play: () => false,
    setStretch: () => {},
    update: () => {},
    dispose() {},
    get playing() { return ''; },
    get stretching() { return ''; },
    get hasSkeleton() { return false; },
    set turn(deg) {}, get turn() { return 0; },
  };
}
