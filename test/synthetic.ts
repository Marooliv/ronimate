// Synthetic human generator: poses a simple skeleton with known joint
// rotations and emits MediaPipe-style landmarks, so the solver's accuracy can
// be measured against ground truth.

import type { Quat, Vec3 } from "../src/math/math3d";
import { DEG, add, qAxisAngle, qFromEulerXYZ, qId, qMul, qRotate } from "../src/math/math3d";
import { LM, NUM_LANDMARKS, type Capture, type CaptureFrame } from "../src/pose/landmarks";
import type { JointPart } from "../src/rig/r15";

export type LocalRot = Record<JointPart, Quat>;

export function identityLocals(): LocalRot {
  const parts: JointPart[] = [
    "LowerTorso", "UpperTorso", "Head", "LeftUpperArm", "LeftLowerArm", "LeftHand", "RightUpperArm",
    "RightLowerArm", "RightHand", "LeftUpperLeg", "LeftLowerLeg", "LeftFoot", "RightUpperLeg", "RightLowerLeg", "RightFoot",
  ];
  return Object.fromEntries(parts.map((p) => [p, qId()])) as LocalRot;
}

/** Landmarks in Roblox space (metres, hip-centred) for the given local rotations. */
export function skeletonLandmarks(r: LocalRot, rootPos: Vec3 = [0, 0, 0]): Vec3[] {
  const P: Vec3[] = new Array(NUM_LANDMARKS).fill(null).map(() => [0, 0, 0] as Vec3);
  const at = (q: Quat, origin: Vec3, v: Vec3) => add(origin, qRotate(q, v));

  const qLT = r.LowerTorso;
  const pelvis: Vec3 = rootPos;
  P[LM.leftHip] = at(qLT, pelvis, [-0.1, 0, 0]);
  P[LM.rightHip] = at(qLT, pelvis, [0.1, 0, 0]);
  const waist = at(qLT, pelvis, [0, 0.1, 0]);
  const qUT = qMul(qLT, r.UpperTorso);
  P[LM.leftShoulder] = at(qUT, waist, [-0.18, 0.42, 0]);
  P[LM.rightShoulder] = at(qUT, waist, [0.18, 0.42, 0]);
  const neck = at(qUT, waist, [0, 0.47, 0]);
  const qH = qMul(qUT, r.Head);
  P[LM.leftEar] = at(qH, neck, [-0.08, 0.1, 0]);
  P[LM.rightEar] = at(qH, neck, [0.08, 0.1, 0]);
  P[LM.leftEye] = at(qH, neck, [-0.03, 0.12, -0.08]);
  P[LM.rightEye] = at(qH, neck, [0.03, 0.12, -0.08]);
  P[LM.leftEyeInner] = at(qH, neck, [-0.015, 0.12, -0.085]);
  P[LM.rightEyeInner] = at(qH, neck, [0.015, 0.12, -0.085]);
  P[LM.leftEyeOuter] = at(qH, neck, [-0.045, 0.12, -0.075]);
  P[LM.rightEyeOuter] = at(qH, neck, [0.045, 0.12, -0.075]);
  P[LM.mouthLeft] = at(qH, neck, [-0.025, 0.04, -0.08]);
  P[LM.mouthRight] = at(qH, neck, [0.025, 0.04, -0.08]);
  P[LM.nose] = at(qH, neck, [0, 0.08, -0.1]);

  for (const side of ["Left", "Right"] as const) {
    const L = side === "Left";
    const S = P[L ? LM.leftShoulder : LM.rightShoulder];
    const qUA = qMul(qUT, r[`${side}UpperArm`]);
    const E = at(qUA, S, [0, -0.3, 0]);
    const qLA = qMul(qUA, r[`${side}LowerArm`]);
    const W = at(qLA, E, [0, -0.27, 0]);
    const qHA = qMul(qLA, r[`${side}Hand`]);
    P[L ? LM.leftElbow : LM.rightElbow] = E;
    P[L ? LM.leftWrist : LM.rightWrist] = W;
    P[L ? LM.leftIndex : LM.rightIndex] = at(qHA, W, [0, -0.08, -0.03]);
    P[L ? LM.leftPinky : LM.rightPinky] = at(qHA, W, [0, -0.08, 0.03]);
    P[L ? LM.leftThumb : LM.rightThumb] = at(qHA, W, [0, -0.04, -0.05]);

    const H = P[L ? LM.leftHip : LM.rightHip];
    const qUL = qMul(qLT, r[`${side}UpperLeg`]);
    const K = at(qUL, H, [0, -0.45, 0]);
    const qLL = qMul(qUL, r[`${side}LowerLeg`]);
    const A = at(qLL, K, [0, -0.42, 0]);
    const qF = qMul(qLL, r[`${side}Foot`]);
    P[L ? LM.leftKnee : LM.rightKnee] = K;
    P[L ? LM.leftAnkle : LM.rightAnkle] = A;
    P[L ? LM.leftHeel : LM.rightHeel] = at(qF, A, [0, -0.07, 0.05]);
    P[L ? LM.leftFootIndex : LM.rightFootIndex] = at(qF, A, [0, -0.07, -0.18]);
  }
  return P;
}

/** Deterministic PRNG so tests are reproducible. */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random but anatomically plausible pose with clearly bent elbows and knees. */
export function randomPose(rand: () => number): LocalRot {
  const u = (a: number, b: number) => (a + (b - a) * rand()) * DEG;
  const r = identityLocals();
  r.LowerTorso = qFromEulerXYZ(u(-20, 20), u(-60, 60), u(-15, 15));
  r.UpperTorso = qAxisAngle([0, 1, 0], u(-30, 30)); // twist only (see test notes)
  r.Head = qFromEulerXYZ(u(-30, 30), u(-50, 50), u(-20, 20));
  for (const side of ["Left", "Right"] as const) {
    const sgn = side === "Left" ? -1 : 1;
    r[`${side}UpperArm`] = qFromEulerXYZ(u(-90, 60), u(-40, 40), sgn * u(0, 100));
    r[`${side}LowerArm`] = qAxisAngle([1, 0, 0], u(30, 130)); // elbow flexes forward
    r[`${side}Hand`] = qFromEulerXYZ(u(-40, 40), u(-60, 60), u(-20, 20));
    r[`${side}UpperLeg`] = qFromEulerXYZ(u(-60, 20), u(-30, 30), sgn * u(0, 25));
    r[`${side}LowerLeg`] = qAxisAngle([1, 0, 0], -u(30, 110)); // knee flexes backward
    r[`${side}Foot`] = qFromEulerXYZ(u(-25, 25), u(-15, 15), u(-10, 10));
  }
  return r;
}

const toMP = (p: Vec3): Vec3 => [-p[0], -p[1], p[2]];

/**
 * Build a Capture as MediaPipe would report it: hip-centred world landmarks
 * plus a perspective projection for a camera `dist` metres in front.
 */
export function syntheticCapture(frames: { rot: LocalRot; pos: Vec3 }[], fps = 30, fovDeg = 60): Capture {
  const width = 1280, height = 720;
  const f = width / 2 / Math.tan((fovDeg * DEG) / 2);
  const out: CaptureFrame[] = frames.map(({ rot, pos }, i) => {
    const P = skeletonLandmarks(rot);
    const hipMid: Vec3 = [(P[LM.leftHip][0] + P[LM.rightHip][0]) / 2, (P[LM.leftHip][1] + P[LM.rightHip][1]) / 2, (P[LM.leftHip][2] + P[LM.rightHip][2]) / 2];
    const world: number[] = [], image: number[] = [];
    for (const p of P) {
      const w = toMP([p[0] - hipMid[0], p[1] - hipMid[1], p[2] - hipMid[2]]);
      world.push(...w);
      // camera space (MediaPipe axes): hip centre sits at `pos` (already MP axes)
      const c = [w[0] + pos[0], w[1] + pos[1], w[2] + pos[2]];
      image.push((f * c[0]) / c[2] / width + 0.5, (f * c[1]) / c[2] / height + 0.5);
    }
    return { t: i / fps, world, image, vis: new Array(NUM_LANDMARKS).fill(0.99) };
  });
  return { version: 1, videoName: "synthetic", width, height, fps, duration: frames.length / fps, model: "synthetic", frames: out };
}
