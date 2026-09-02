import * as THREE from 'three';

/*
 * hand-pose.ts — how the hand holds the phone.
 *
 * Pure geometry, no DOM: given the loaded hand model, this module rebuilds its
 * joint hierarchy, works out which way is "curl" for every finger from the
 * joints themselves, closes the hand into a grip, and turns, scales and places
 * it so the grip lands on the phone. HandScene.tsx owns the canvases, lights
 * and frame loop; everything about the pose is here so it can be tuned in one
 * place, blind, by reading the numbers in the dev log.
 *
 * THE MODEL
 * public/models/hand-right.glb is a right hand in a flat rest pose, fingers
 * extended, ~21 cm long, skinned to 25 joints named per the WebXR hand
 * standard. Its own axes (measured, not assumed — see `buildHandRig`): the
 * fingers point along −Y, the palm faces −X and the thumb sits at −Z. None of
 * that is hard-coded: the frame is derived from the wrist, the middle
 * fingertip and the index/pinky knuckles at load, so a re-exported model with
 * different axes poses the same.
 *
 * WHY THE HIERARCHY IS REBUILT
 * In the file the 25 joints are flat siblings under `Armature` — each carries
 * its own absolute rest transform and none is a child of another. Rotating a
 * knuckle would therefore move nothing beyond it. `buildHandRig` reparents the
 * joints into the anatomical chains with `Object3D.attach`, which keeps every
 * world transform (so the skin's bind pose is untouched) and makes each joint
 * rotate everything downstream of it, as a finger does.
 *
 * WHY EVERY ANGLE IS ABOUT A DERIVED AXIS
 * A joint's local axes in this export are not aligned to anything a person
 * would call "curl". So each hinge's axis is computed in model space — the
 * cross product of the bone's direction and the palm normal — and converted
 * once into the joint's own rest frame. Curling is then a single rotation
 * about that axis, and because it is applied in the joint's frame, a knuckle
 * that has already curled carries its finger's remaining hinges with it.
 *
 * WHY THE HAND IS 1.7 PHONE-WIDTHS LONG (the brief said "about 1.45")
 * The brief also asks for the wrist below and right of the phone's bottom-right
 * corner with the fingers curling round the LEFT edge. From the wrist to the
 * middle finger's second knuckle (where the finger meets the edge) is 0.66 of
 * the hand's length once the first knuckle is curled 55°; at 1.45 widths that
 * reach is ~385 px against a 400 px phone, so the wrist could only ever land
 * at the bottom centre. 1.7 is the smallest ratio at which the geometry the
 * brief describes closes. Lower `HAND_LENGTH_RATIO` and the placement still
 * works — the wrist just walks toward the centre of the bottom edge.
 *
 * WHY PLACEMENT ANCHORS THE FINGERS, NOT THE WRIST
 * The one thing the viewer must read is fingers crossing the bezel's left edge
 * in front of the screen. So the hand is positioned by putting the index and
 * middle fingers' second knuckles exactly at that edge, just behind the screen
 * plane, and letting the wrist fall where the anatomy puts it. The dev log
 * reports where that was.
 */

/* ------------------------------------------------------------- tuning --
 * All angles in degrees, all lengths in CSS px unless noted. World units in
 * HandScene are CSS px with the phone's centre at the origin, x right, y up,
 * z toward the reader; the screen is the plane z = 0. */

/** Hand length (wrist joint to middle fingertip, at rest) as a multiple of the phone's width. */
export const HAND_LENGTH_RATIO = 1.66;

/** Angle of the fingers above "pointing straight left across the back of the
 *  phone". 0 lays the palm horizontal; 90 points the fingers straight up.
 *  Larger values move the wrist down and toward the centre. */
export const FINGER_ELEVATION_DEG = 20;

/** Where the index/middle fingers cross the left edge, as a fraction of the
 *  phone's height from the bottom. The pinky sits ~0.35 of the height lower. */
export const GRIP_HEIGHT = 0.34;

/** How far outside the bezel's left edge the fingers' second knuckles sit —
 *  about one finger radius, so the flesh hugs the edge rather than the bone. */
export const GRIP_OUTSET_PX = 58;

/** Depth of those knuckles: just behind the screen plane, so the intermediate
 *  and distal phalanges (everything past the knuckle) cross into z > 0 and are
 *  drawn by the front canvas, over the bezel. */
export const GRIP_DEPTH_PX = -8;

/** Finger curl at the three knuckles, base to tip. Larger proximal curl also
 *  pushes the palm further behind the phone (it pivots about the edge). */
export const CURL_DEG = { proximal: 42, intermediate: 52, distal: 22 } as const;

/** Per-finger adjustment added to every knuckle's curl: index, middle, ring,
 *  pinky. The index relaxes a little, the pinky tucks a little more. */
export const FINGER_CURL_BIAS_DEG = [-5, 0, 2, 6] as const;

/** The thumb. `spread` swings it away from the fingers within the palm plane
 *  (positive = toward the phone's right edge); the three flexions bend it
 *  toward the palm normal, i.e. forward over the bezel. */
export const THUMB_DEG = { spread: 48, metacarpal: 6, proximal: 14, distal: 8 } as const;

/** Idle breathing: the finger curl drifts ±this over one period. */
export const BREATHE_DEG = 2;
export const BREATHE_PERIOD_S = 4;

/* ----------------------------------------------------------- skeleton -- */

const FINGERS = ['index-finger', 'middle-finger', 'ring-finger', 'pinky-finger'] as const;

const THUMB_CHAIN = ['wrist', 'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'];
const FINGER_CHAINS = FINGERS.map((f) => [
  'wrist',
  `${f}-metacarpal`,
  `${f}-phalanx-proximal`,
  `${f}-phalanx-intermediate`,
  `${f}-phalanx-distal`,
  `${f}-tip`,
]);
const CHAINS = [THUMB_CHAIN, ...FINGER_CHAINS];

/** Every joint the pose needs. A model missing any of them is not posed. */
export const JOINT_NAMES: readonly string[] = Array.from(new Set(CHAINS.flat()));

interface Hinge {
  bone: THREE.Bone;
  /** The joint's local rotation at rest, after reparenting. */
  rest: THREE.Quaternion;
  /** Rotation axis in the joint's rest frame. */
  axis: THREE.Vector3;
  /** Degrees. */
  angle: number;
  /** How much of the breathing offset this hinge takes. */
  breathe: number;
}

export interface HandRig {
  /** Orientation, scale and placement. Add this to the scene (or a tilt group). */
  root: THREE.Group;
  /** The cloned glTF scene, now with a real joint hierarchy. */
  model: THREE.Object3D;
  mesh: THREE.SkinnedMesh;
  bones: Map<string, THREE.Bone>;
  hinges: Hinge[];
  /** Wrist to middle fingertip at rest, in the model's own units (metres). */
  restLength: number;
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();

/**
 * Turn a freshly cloned hand model into a rig: rebuild the joint hierarchy,
 * derive the hinge axes, and orient the hand fingers-up with the palm toward
 * the reader (then rolled by FINGER_ELEVATION_DEG). The model must not yet be
 * inside anything transformed. Returns null if the model is not the hand
 * expected (a joint or the skinned mesh is missing), in which case nothing has
 * been changed.
 */
export function buildHandRig(model: THREE.Object3D): HandRig | null {
  const bones = new Map<string, THREE.Bone>();
  const meshes: THREE.SkinnedMesh[] = [];
  model.traverse((o) => {
    if ((o as THREE.Bone).isBone) bones.set(o.name, o as THREE.Bone);
    else if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh);
  });
  const mesh = meshes[0];
  if (!mesh) return null;
  for (const name of JOINT_NAMES) if (!bones.has(name)) return null;
  const bone = (name: string) => bones.get(name) as THREE.Bone;

  model.updateMatrixWorld(true);

  /* Chains, not a flat list: each joint becomes the child of the one before
   * it. `attach` keeps world transforms, so the skin does not move. */
  for (const chain of CHAINS) {
    for (let i = 1; i < chain.length; i++) bone(chain[i - 1]).attach(bone(chain[i]));
  }
  model.updateMatrixWorld(true);

  /* Positions in model space. `worldToLocal` makes this true even if the
   * caller has already parented the model somewhere. */
  const at = (name: string, out: THREE.Vector3) => model.worldToLocal(bone(name).getWorldPosition(out));

  /* The hand's frame, from the joints: along the fingers, across the
   * knuckles, and (their cross product) out of the palm. For a right hand,
   * fingers × (index→pinky) points to the palm side; the thumb is then on
   * fingers × palm. */
  const fingerDir = at('middle-finger-tip', new THREE.Vector3()).sub(at('wrist', _v1)).normalize();
  const across = at('pinky-finger-metacarpal', new THREE.Vector3()).sub(at('index-finger-metacarpal', _v1)).normalize();
  const palm = new THREE.Vector3().crossVectors(fingerDir, across).normalize();
  const thumbSide = new THREE.Vector3().crossVectors(fingerDir, palm).normalize();
  const restLength = at('middle-finger-tip', _v1).distanceTo(at('wrist', _v2));
  if (!(restLength > 0) || palm.lengthSq() < 0.5) return null;

  /* Each hinge's axis, in model space, then expressed in the joint's own rest
   * frame so a single local rotation curls it. The model's own orientation
   * is divided out in case the clone was handed over already rotated. */
  const modelQuatInverse = model.getWorldQuaternion(new THREE.Quaternion()).invert();
  const hinges: Hinge[] = [];
  const hinge = (name: string, axisModel: THREE.Vector3, angle: number, breathe: number) => {
    const b = bone(name);
    const jointQuat = b.getWorldQuaternion(_q1).premultiply(modelQuatInverse);
    const axis = axisModel.clone().applyQuaternion(_q2.copy(jointQuat).invert()).normalize();
    hinges.push({ bone: b, rest: b.quaternion.clone(), axis, angle, breathe });
  };
  /* Curl axis: rotating the bone's direction about (bone × palm) moves the
   * tip toward the palm. */
  const curlAxis = (name: string, childName: string) => {
    const dir = at(childName, _v1).sub(at(name, _v2)).normalize();
    return new THREE.Vector3().crossVectors(dir, palm).normalize();
  };

  FINGERS.forEach((f, i) => {
    const bias = FINGER_CURL_BIAS_DEG[i];
    hinge(`${f}-phalanx-proximal`, curlAxis(`${f}-phalanx-proximal`, `${f}-phalanx-intermediate`), CURL_DEG.proximal + bias, 1);
    hinge(`${f}-phalanx-intermediate`, curlAxis(`${f}-phalanx-intermediate`, `${f}-phalanx-distal`), CURL_DEG.intermediate + bias, 0.5);
    hinge(`${f}-phalanx-distal`, curlAxis(`${f}-phalanx-distal`, `${f}-tip`), CURL_DEG.distal + bias * 0.5, 0);
  });
  /* The thumb: first swung within the palm plane (about the palm normal,
   * negated so positive spread is away from the fingers), then flexed at
   * each of its three joints toward the palm normal, i.e. over the bezel. */
  hinge('thumb-metacarpal', palm.clone().negate(), THUMB_DEG.spread, 0);
  hinge('thumb-metacarpal', curlAxis('thumb-metacarpal', 'thumb-phalanx-proximal'), THUMB_DEG.metacarpal, 0);
  hinge('thumb-phalanx-proximal', curlAxis('thumb-phalanx-proximal', 'thumb-phalanx-distal'), THUMB_DEG.proximal, 0.5);
  hinge('thumb-phalanx-distal', curlAxis('thumb-phalanx-distal', 'thumb-tip'), THUMB_DEG.distal, 0);

  /* Orientation: the model's (thumbSide, fingerDir, palm) frame becomes the
   * world's (+X, +Y, +Z) — thumb to the right, fingers up, palm toward the
   * reader — and the whole hand is then rolled anticlockwise so the fingers
   * point up-left across the back of the phone. */
  const orient = new THREE.Quaternion().setFromRotationMatrix(_m1.makeBasis(thumbSide, fingerDir, palm)).invert();
  const roll = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 0, 1),
    THREE.MathUtils.degToRad(90 - FINGER_ELEVATION_DEG),
  );
  const root = new THREE.Group();
  root.name = 'hand';
  root.quaternion.copy(roll).multiply(orient);
  root.add(model);

  return { root, model, mesh, bones, hinges, restLength };
}

/**
 * Apply the grip. `breath` is the current breathing offset in degrees (0 for
 * a still hand) and is added, weighted, to the finger curl.
 */
export function poseHand(rig: HandRig, breath = 0): void {
  for (const h of rig.hinges) h.bone.quaternion.copy(h.rest);
  for (const h of rig.hinges) {
    const deg = h.angle + h.breathe * breath;
    if (deg === 0) continue;
    _q1.setFromAxisAngle(h.axis, THREE.MathUtils.degToRad(deg));
    h.bone.quaternion.multiply(_q1);
  }
}

/* A joint's position in the space the rig's root sits in — the tilt group's,
 * i.e. phone px about the phone's centre, before any tilt. */
function jointInStage(rig: HandRig, name: string, out: THREE.Vector3): THREE.Vector3 {
  const b = rig.bones.get(name);
  if (!b) return out.set(0, 0, 0);
  b.getWorldPosition(out);
  return rig.root.parent ? rig.root.parent.worldToLocal(out) : out;
}

/**
 * Scale the hand to the phone and put the grip on its left edge. Call after
 * `poseHand` (the anchor joints move with the curl) and whenever the phone's
 * box changes. `width`/`height` are the phone's box in CSS px.
 */
export function placeHand(rig: HandRig, width: number, height: number): void {
  const root = rig.root;
  root.scale.setScalar((HAND_LENGTH_RATIO * width) / rig.restLength);
  root.position.set(0, 0, 0);
  root.updateMatrixWorld(true);

  const anchor = jointInStage(rig, 'index-finger-phalanx-intermediate', _v1)
    .add(jointInStage(rig, 'middle-finger-phalanx-intermediate', _v2))
    .multiplyScalar(0.5);
  const target = _v3.set(-width / 2 - GRIP_OUTSET_PX, -height / 2 + GRIP_HEIGHT * height, GRIP_DEPTH_PX);
  root.position.copy(target).sub(anchor);
  root.updateMatrixWorld(true);
}

type Triple = [number, number, number];

export interface HandReport {
  /** Model metres → CSS px. */
  scale: number;
  /** Hand length in px, wrist to middle fingertip at rest. */
  length: number;
  /** Phone box, for reference: x is ±width/2, y is ±height/2, screen at z 0. */
  phone: { halfWidth: number; halfHeight: number };
  wrist: Triple;
  thumbTip: Triple;
  /** Second knuckles, where each finger meets the left edge. */
  knuckles: Record<string, Triple>;
  tips: Record<string, Triple>;
  /** Extent of the joints. */
  jointBounds: { min: Triple; max: Triple };
  /** Extent of the skinned surface, if it could be computed. */
  meshBounds?: { min: Triple; max: Triple };
}

const triple = (v: THREE.Vector3): Triple => [Math.round(v.x), Math.round(v.y), Math.round(v.z)];

/** Where everything landed, in phone px, for the dev log. */
export function describeHand(rig: HandRig, width: number, height: number): HandReport {
  const knuckles: Record<string, Triple> = {};
  const tips: Record<string, Triple> = {};
  const jointBox = new THREE.Box3();
  for (const name of JOINT_NAMES) jointBox.expandByPoint(jointInStage(rig, name, _v1));
  for (const f of FINGERS) {
    const key = f.replace('-finger', '');
    knuckles[key] = triple(jointInStage(rig, `${f}-phalanx-intermediate`, _v1));
    tips[key] = triple(jointInStage(rig, `${f}-tip`, _v1));
  }
  const report: HandReport = {
    scale: Math.round(rig.root.scale.x),
    length: Math.round(rig.restLength * rig.root.scale.x),
    phone: { halfWidth: width / 2, halfHeight: height / 2 },
    wrist: triple(jointInStage(rig, 'wrist', _v1)),
    thumbTip: triple(jointInStage(rig, 'thumb-tip', _v1)),
    knuckles,
    tips,
    jointBounds: { min: triple(jointBox.min), max: triple(jointBox.max) },
  };
  try {
    /* The posed surface: three skins each vertex on the CPU for this, which
     * is fine for 1,360 vertices once in development. */
    rig.mesh.computeBoundingBox();
    const local = rig.mesh.boundingBox;
    if (local && !local.isEmpty()) {
      const box = new THREE.Box3();
      const parent = rig.root.parent;
      for (let i = 0; i < 8; i++) {
        _v1.set(i & 1 ? local.max.x : local.min.x, i & 2 ? local.max.y : local.min.y, i & 4 ? local.max.z : local.min.z);
        _v1.applyMatrix4(rig.mesh.matrixWorld);
        box.expandByPoint(parent ? parent.worldToLocal(_v1) : _v1);
      }
      report.meshBounds = { min: triple(box.min), max: triple(box.max) };
    }
  } catch {
    /* Bounds are a courtesy; the placement does not depend on them. */
  }
  return report;
}
