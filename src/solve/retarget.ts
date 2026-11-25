// Turns MediaPipe landmarks into R15 Motor6D transforms.
//
// Approach: for every frame we estimate the *world* orientation of each R15
// part directly from the landmarks (torso/head/hands/feet from 3+ points,
// limb segments from their bone direction plus a twist reference), then take
// local = parentWorld⁻¹ · childWorld. Solving in world space means errors in
// one joint never accumulate down the chain.

import type { Quat, Vec3 } from "../math/math3d";
import {
  DEG, add, basisFromXY, basisFromZY, cross, dot, len, mid, norm, qAxisAngle, qConj, qFromBasis,
  qFromEulerXYZ, qFromTo, qId, qMul, qNorm, qRotate, qSlerp, reject, scale, smoothstep, sub,
} from "../math/math3d";
import { LM, MIRROR_MAP, NUM_LANDMARKS, type Capture } from "../pose/landmarks";
import { lowestPoint, restPose, solveFK, type RigPose } from "../rig/fk";
import { JOINT_PARTS, RIG_LEG_LENGTH, type JointPart } from "../rig/r15";
import { fillGaps, gaussianSmooth, oneEuroZeroPhase, smoothQuats, smoothingToCutoff } from "./filter";
import type { Settings } from "./settings";

export interface SolvedClip {
  fps: number;
  /** Seconds, starting at 0 (already trimmed). */
  times: number[];
  poses: RigPose[];
  /** Index into the capture's frames for each solved frame (for overlay sync). */
  sourceIndex: number[];
  /** Per-frame overall tracking confidence 0..1. */
  confidence: number[];
  studsPerMetre: number;
  /** Video time (seconds) that corresponds to clip time 0. */
  videoOffset: number;
  /** Direction the real camera was looking, in rig space (for "camera view"). */
  cameraDir: Vec3;
}

// ---------------------------------------------------------------- landmark prep

/** Filtered landmark tracks: pts[frame][landmark] in MediaPipe metres, plus visibility. */
interface Tracks {
  pts: Vec3[][];
  vis: number[][];
  valid: boolean[];
}

function buildTracks(cap: Capture, s: Settings): Tracks {
  const n = cap.frames.length;
  const valid = cap.frames.map((f) => !!f.world);
  const pts: Vec3[][] = Array.from({ length: n }, () => new Array<Vec3>(NUM_LANDMARKS));
  const vis: number[][] = Array.from({ length: n }, () => new Array<number>(NUM_LANDMARKS).fill(0));
  const minCutoff = smoothingToCutoff(s.smoothing);
  const beta = (s.responsiveness / 100) * 4;
  const series = new Float64Array(n);

  for (let l = 0; l < NUM_LANDMARKS; l++) {
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < n; i++) series[i] = cap.frames[i].world ? cap.frames[i].world![l * 3 + c] : NaN;
      if (!fillGaps(series)) series.fill(0);
      const f = oneEuroZeroPhase(series, cap.fps, minCutoff, beta);
      for (let i = 0; i < n; i++) {
        if (c === 0) pts[i][l] = [0, 0, 0];
        pts[i][l][c] = f[i];
      }
    }
    for (let i = 0; i < n; i++) series[i] = cap.frames[i].vis ? cap.frames[i].vis![l] : NaN;
    if (!fillGaps(series)) series.fill(0);
    for (let i = 0; i < n; i++) vis[i][l] = series[i];
  }
  return { pts, vis, valid };
}

/** MediaPipe (x right, y down, z away) → Roblox (character facing camera looks down -Z). */
const toRoblox = (p: Vec3): Vec3 => [-p[0], -p[1], p[2]];

// ---------------------------------------------------------------- camera translation

/**
 * Recover the hip-centre position in camera space by fitting the metric world
 * skeleton to the 2D detections with a pinhole camera (linear least squares).
 */
export function solveTranslation(
  world: Vec3[], image: number[], vis: number[], width: number, height: number, fovDeg: number,
): Vec3 | null {
  const f = width / 2 / Math.tan((fovDeg * DEG) / 2);
  const cx = width / 2, cy = height / 2;
  // Normal equations for A t = b with t = (tx, ty, tz)
  let a00 = 0, a02 = 0, a11 = 0, a12 = 0, a22 = 0, b0 = 0, b1 = 0, b2 = 0, used = 0;
  for (let i = 11; i < NUM_LANDMARKS; i++) {
    const w = vis[i];
    if (w < 0.5) continue;
    const [X, Y, Z] = world[i];
    const du = image[i * 2] * width - cx;
    const dv = image[i * 2 + 1] * height - cy;
    // row u: [f, 0, -du] · t = du*Z - f*X
    const ru = du * Z - f * X;
    a00 += w * f * f; a02 += w * f * -du; a22 += w * du * du; b0 += w * f * ru; b2 += w * -du * ru;
    // row v: [0, f, -dv] · t = dv*Z - f*Y
    const rv = dv * Z - f * Y;
    a11 += w * f * f; a12 += w * f * -dv; a22 += w * dv * dv; b1 += w * f * rv; b2 += w * -dv * rv;
    used++;
  }
  if (used < 4) return null;
  const t = solve3([[a00, 0, a02], [0, a11, a12], [a02, a12, a22]], [b0, b1, b2]);
  if (!t) return null;
  const [tx, ty, tz] = t;
  if (!(tz > 0)) return null;
  return [tx, ty, tz];
}

/** Solve a 3×3 linear system with Cramer's rule. */
export function solve3(m: number[][], b: number[]): Vec3 | null {
  const det3 = (a: number[][]) =>
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
    a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
    a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const d = det3(m);
  if (Math.abs(d) < 1e-12) return null;
  const col = (c: number) => m.map((row, r) => row.map((v, k) => (k === c ? b[r] : v)));
  return [det3(col(0)) / d, det3(col(1)) / d, det3(col(2)) / d];
}

// ---------------------------------------------------------------- orientation helpers

const UP: Vec3 = [0, 1, 0];
/** Upper-arm "T-pose" reference: twist is measured relative to arms held out sideways,
 *  which puts the swing singularity across the chest instead of straight overhead. */
const T_REF: Record<"Left" | "Right", Quat> = {
  Left: qAxisAngle([0, 0, 1], -Math.PI / 2),
  Right: qAxisAngle([0, 0, 1], Math.PI / 2),
};

interface TwistRef {
  x: Vec3;
  w: number;
}

/**
 * Orientation of a limb segment whose +Y must point along `yWorld`.
 * Twist about that axis is a weighted circular mean of: zero-twist relative to
 * the parent (weight `baseW`) and each reference X axis.
 */
function segmentOrientation(parent: Quat, refLocal: Quat, yWorld: Vec3, refs: TwistRef[], baseW: number): Quat {
  const refFrame = qMul(parent, refLocal);
  const refY = qRotate(refFrame, UP);
  const zeroTwist = qNorm(qMul(qFromTo(refY, yWorld), refFrame));
  const xs = qRotate(zeroTwist, [1, 0, 0]);
  let sx = baseW, sy = 0;
  for (const r of refs) {
    if (r.w <= 1e-4) continue;
    const p = reject(r.x, yWorld);
    const l = len(p);
    if (l < 1e-4) continue;
    const pn = scale(p, 1 / l);
    const th = Math.atan2(dot(cross(xs, pn), yWorld), dot(xs, pn));
    sx += r.w * Math.cos(th);
    sy += r.w * Math.sin(th);
  }
  if (Math.hypot(sx, sy) < 1e-6) return zeroTwist;
  const th = Math.atan2(sy, sx);
  return qNorm(qMul(qAxisAngle(yWorld, th), zeroTwist));
}

const hingeConfidence = (a: Vec3, b: Vec3) => {
  const s = len(cross(a, b)) / Math.max(1e-9, len(a) * len(b));
  return smoothstep(0.12, 0.35, s);
};

/** Per-joint landmarks that must be visible for the joint to be trusted. */
const JOINT_LANDMARKS: Record<JointPart, number[]> = {
  LowerTorso: [LM.leftHip, LM.rightHip, LM.leftShoulder, LM.rightShoulder],
  UpperTorso: [LM.leftShoulder, LM.rightShoulder],
  Head: [LM.nose, LM.leftEar, LM.rightEar],
  LeftUpperArm: [LM.leftShoulder, LM.leftElbow],
  LeftLowerArm: [LM.leftElbow, LM.leftWrist],
  LeftHand: [LM.leftWrist, LM.leftIndex, LM.leftPinky],
  RightUpperArm: [LM.rightShoulder, LM.rightElbow],
  RightLowerArm: [LM.rightElbow, LM.rightWrist],
  RightHand: [LM.rightWrist, LM.rightIndex, LM.rightPinky],
  LeftUpperLeg: [LM.leftHip, LM.leftKnee],
  LeftLowerLeg: [LM.leftKnee, LM.leftAnkle],
  LeftFoot: [LM.leftAnkle, LM.leftHeel, LM.leftFootIndex],
  RightUpperLeg: [LM.rightHip, LM.rightKnee],
  RightLowerLeg: [LM.rightKnee, LM.rightAnkle],
  RightFoot: [LM.rightAnkle, LM.rightHeel, LM.rightFootIndex],
};

/** World orientations of every R15 part for one frame of (Roblox-space) landmarks. */
export function solveWorldOrientations(P: Vec3[], s: Pick<Settings, "waistShare" | "footTwist">): Record<JointPart, Quat> {
  const out = {} as Record<JointPart, Quat>;
  const hipMid = mid(P[LM.leftHip], P[LM.rightHip]);
  const shMid = mid(P[LM.leftShoulder], P[LM.rightShoulder]);
  const spine = sub(shMid, hipMid);

  // Pelvis: hip line + spine. Part of the bend is handed to the waist.
  const hipX = sub(P[LM.rightHip], P[LM.leftHip]);
  const pelvis = qFromBasis(basisFromXY(hipX, spine));
  const upright = qFromBasis(basisFromXY(hipX, UP));
  out.LowerTorso = qSlerp(upright, pelvis, 1 - s.waistShare);

  out.UpperTorso = qFromBasis(basisFromXY(sub(P[LM.rightShoulder], P[LM.leftShoulder]), spine));

  const earX = sub(P[LM.rightEar], P[LM.leftEar]);
  const eyeMid = mid(P[LM.leftEye], P[LM.rightEye]);
  const mouthMid = mid(P[LM.mouthLeft], P[LM.mouthRight]);
  out.Head = qFromBasis(basisFromXY(earX, sub(eyeMid, mouthMid)));

  for (const side of ["Left", "Right"] as const) {
    const L = side === "Left";
    const S = P[L ? LM.leftShoulder : LM.rightShoulder];
    const E = P[L ? LM.leftElbow : LM.rightElbow];
    const W = P[L ? LM.leftWrist : LM.rightWrist];
    const I = P[L ? LM.leftIndex : LM.rightIndex];
    const K = P[L ? LM.leftPinky : LM.rightPinky];

    const up = sub(E, S), lo = sub(W, E);
    const conf = hingeConfidence(up, lo);
    const hinge = norm(cross(up, lo), [1, 0, 0]); // elbow flexion axis == segment +X
    const upper = segmentOrientation(out.UpperTorso, T_REF[side], norm(scale(up, -1)), [{ x: hinge, w: conf }], 1 - conf);
    const lower = segmentOrientation(upper, qId(), norm(scale(lo, -1)), [{ x: hinge, w: conf }], 1 - conf);
    // Hand: wrist→knuckles gives -Y, pinky→index gives -Z (palm faces the body at rest).
    const hy = norm(sub(W, mid(I, K)));
    const hz = norm(reject(sub(K, I), hy), [0, 0, 1]);
    const hand = qFromBasis({ x: cross(hy, hz), y: hy, z: hz });
    out[`${side}UpperArm`] = upper;
    out[`${side}LowerArm`] = lower;
    out[`${side}Hand`] = hand;
  }

  for (const side of ["Left", "Right"] as const) {
    const L = side === "Left";
    const H = P[L ? LM.leftHip : LM.rightHip];
    const K = P[L ? LM.leftKnee : LM.rightKnee];
    const A = P[L ? LM.leftAnkle : LM.rightAnkle];
    const He = P[L ? LM.leftHeel : LM.rightHeel];
    const T = P[L ? LM.leftFootIndex : LM.rightFootIndex];

    const up = sub(K, H), lo = sub(A, K);
    const conf = hingeConfidence(up, lo);
    const hinge = norm(scale(cross(up, lo), -1), [1, 0, 0]); // knee flexion axis == segment +X
    const fwd = sub(T, He);
    const yU = norm(scale(up, -1));
    const yL = norm(scale(lo, -1));
    const ft = (1 - conf) * s.footTwist;
    const upper = segmentOrientation(out.LowerTorso, qId(), yU, [{ x: hinge, w: conf }, { x: cross(fwd, yU), w: ft }], (1 - conf) * (1 - s.footTwist));
    const lower = segmentOrientation(upper, qId(), yL, [{ x: hinge, w: conf }, { x: cross(fwd, yL), w: ft }], (1 - conf) * (1 - s.footTwist));
    const foot = qFromBasis(basisFromZY(sub(He, T), sub(A, mid(He, T))));
    out[`${side}UpperLeg`] = upper;
    out[`${side}LowerLeg`] = lower;
    out[`${side}Foot`] = foot;
  }
  return out;
}

const PARENT: Record<JointPart, JointPart | null> = {
  LowerTorso: null,
  UpperTorso: "LowerTorso",
  Head: "UpperTorso",
  LeftUpperArm: "UpperTorso",
  LeftLowerArm: "LeftUpperArm",
  LeftHand: "LeftLowerArm",
  RightUpperArm: "UpperTorso",
  RightLowerArm: "RightUpperArm",
  RightHand: "RightLowerArm",
  LeftUpperLeg: "LowerTorso",
  LeftLowerLeg: "LeftUpperLeg",
  LeftFoot: "LeftLowerLeg",
  RightUpperLeg: "LowerTorso",
  RightLowerLeg: "RightUpperLeg",
  RightFoot: "RightLowerLeg",
};
export { PARENT as JOINT_PARENT };

/** World orientations → Motor6D.Transform rotations (HumanoidRootPart assumed identity). */
export function worldToLocal(world: Record<JointPart, Quat>): Record<JointPart, Quat> {
  const out = {} as Record<JointPart, Quat>;
  for (const j of JOINT_PARTS) {
    const p = PARENT[j];
    out[j] = p ? qNorm(qMul(qConj(world[p]), world[j])) : world[j];
  }
  return out;
}

// ---------------------------------------------------------------- level / heading

function levelQuat(pitchDeg: number, rollDeg: number): Quat {
  return qMul(qAxisAngle([0, 0, 1], rollDeg * DEG), qAxisAngle([1, 0, 0], pitchDeg * DEG));
}

/**
 * Estimate camera pitch (a phone tilted down/up makes the whole body appear to
 * lean) from the median shoulder→ankle direction. Roll is left at 0: wide or
 * asymmetric stances bias a roll estimate, and phones are rarely rolled.
 */
export function estimateLevel(cap: Capture): { pitchDeg: number; rollDeg: number } {
  const pitches: number[] = [];
  for (const f of cap.frames) {
    if (!f.world || !f.vis) continue;
    const g = (i: number): Vec3 => toRoblox([f.world![i * 3], f.world![i * 3 + 1], f.world![i * 3 + 2]]);
    const need = [LM.leftShoulder, LM.rightShoulder, LM.leftAnkle, LM.rightAnkle];
    const useAnkles = need.every((i) => f.vis![i] > 0.5);
    const top = mid(g(LM.leftShoulder), g(LM.rightShoulder));
    const bottom = useAnkles ? mid(g(LM.leftAnkle), g(LM.rightAnkle)) : mid(g(LM.leftHip), g(LM.rightHip));
    const u = sub(top, bottom);
    if (u[1] <= 0) continue;
    const p = Math.atan2(-u[2], u[1]) / DEG;
    if (Math.abs(p) < 40) pitches.push(p);
  }
  if (!pitches.length) return { pitchDeg: 0, rollDeg: 0 };
  pitches.sort((a, b) => a - b);
  return { pitchDeg: Math.round(pitches[Math.floor(pitches.length / 2)] * 10) / 10, rollDeg: 0 };
}

// ---------------------------------------------------------------- main entry

export function solveClip(cap: Capture, s: Settings): SolvedClip {
  const n = cap.frames.length;
  const empty: SolvedClip = { fps: cap.fps, times: [], poses: [], sourceIndex: [], confidence: [], studsPerMetre: 1, videoOffset: 0, cameraDir: [0, 0, 1] };
  if (!n || !cap.frames.some((f) => f.world)) return empty;

  const tracks = buildTracks(cap, s);
  const level = levelQuat(s.pitchDeg, s.rollDeg);
  const mirrorIdx = (i: number) => (s.mirror ? MIRROR_MAP[i] : i);
  const mirrorV = (v: Vec3): Vec3 => (s.mirror ? [-v[0], v[1], v[2]] : v);

  // Landmarks in Roblox space, levelled, mirrored.
  let points: Vec3[][] = tracks.pts.map((frame) =>
    frame.map((_, i) => qRotate(level, mirrorV(toRoblox(frame[mirrorIdx(i)])))),
  );
  const visibility = tracks.vis.map((v) => v.map((_, i) => v[mirrorIdx(i)]));

  // Camera-space hip translation per frame.
  const rawT: (Vec3 | null)[] = cap.frames.map((f, i) =>
    f.world && f.image && f.vis
      ? solveTranslation(tracks.pts[i], f.image, f.vis, cap.width, cap.height, s.fovDeg)
      : null,
  );

  // Heading: rotate everything so the subject starts facing the Roblox forward (-Z).
  let yaw = s.yawDeg * DEG;
  if (s.faceForward) {
    let sx = 0, sz = 0, count = 0;
    for (let i = 0; i < n && count < 15; i++) {
      if (!tracks.valid[i]) continue;
      const hx = sub(points[i][LM.rightHip], points[i][LM.leftHip]);
      const sh = sub(points[i][LM.rightShoulder], points[i][LM.leftShoulder]);
      const x = norm(add(norm(hx), norm(sh)));
      sx += x[0];
      sz += x[2];
      count++;
    }
    yaw += Math.atan2(sz, sx);
  }
  const yawQ = qAxisAngle(UP, yaw);
  const frameRot = qMul(yawQ, level);
  points = points.map((frame) => frame.map((p) => qRotate(yawQ, p)));

  // Leg length → studs per metre.
  const legs: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!tracks.valid[i]) continue;
    const P = points[i], V = visibility[i];
    for (const [h, k, a] of [[LM.leftHip, LM.leftKnee, LM.leftAnkle], [LM.rightHip, LM.rightKnee, LM.rightAnkle]]) {
      if (V[h] > 0.5 && V[k] > 0.5 && V[a] > 0.5) legs.push(len(sub(P[k], P[h])) + len(sub(P[a], P[k])));
    }
  }
  legs.sort((a, b) => a - b);
  const legLen = legs.length ? legs[Math.floor(legs.length / 2)] : 0.85;
  const studsPerMetre = RIG_LEG_LENGTH / Math.max(0.3, legLen);

  // ---- rotations
  const tracksLocal = {} as Record<JointPart, Quat[]>;
  for (const j of JOINT_PARTS) tracksLocal[j] = [];
  const confidence: number[] = [];
  const prev = restPose().rot;
  for (let i = 0; i < n; i++) {
    const world = solveWorldOrientations(points[i], s);
    const local = worldToLocal(world);
    let confSum = 0;
    for (const j of JOINT_PARTS) {
      const v = Math.min(...JOINT_LANDMARKS[j].map((l) => visibility[i][l]));
      const c = smoothstep(s.visThreshold - 0.1, s.visThreshold + 0.1, v);
      confSum += c;
      const q = qSlerp(prev[j], local[j], c);
      prev[j] = q;
      tracksLocal[j].push(q);
    }
    confidence.push(confSum / JOINT_PARTS.length);
  }

  // ---- per-joint post: smoothing, offsets, strength
  for (const j of JOINT_PARTS) {
    const tw = s.joints[j];
    const off = qFromEulerXYZ(tw.offset[0] * DEG, tw.offset[1] * DEG, tw.offset[2] * DEG);
    tracksLocal[j] = smoothQuats(tracksLocal[j], s.rotSmoothing).map((q) =>
      qSlerp(qId(), qMul(q, off), Math.max(0, Math.min(1, tw.strength))),
    );
  }

  // ---- root translation
  const series = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  for (let i = 0; i < n; i++) {
    const t = rawT[i];
    for (let c = 0; c < 3; c++) series[c][i] = t ? t[c] : NaN;
  }
  const hasT = series.every((x) => fillGaps(x));
  const smoothT = series.map((x, c) => gaussianSmooth(x, s.rootSmoothing * (c === 2 ? 2 : 1)));
  const rootPos: Vec3[] = [];
  const k = studsPerMetre * s.rootScale;
  for (let i = 0; i < n; i++) {
    if (!hasT) {
      rootPos.push([0, 0, 0]);
      continue;
    }
    const cam: Vec3 = [smoothT[0][i] - smoothT[0][0], smoothT[1][i] - smoothT[1][0], smoothT[2][i] - smoothT[2][0]];
    rootPos.push(scale(qRotate(frameRot, mirrorV(toRoblox(cam))), k));
  }

  // ---- assemble poses + vertical placement
  const poses: RigPose[] = [];
  const lows: number[] = [];
  for (let i = 0; i < n; i++) {
    const rot = {} as Record<JointPart, Quat>;
    for (const j of JOINT_PARTS) rot[j] = tracksLocal[j][i];
    const pose: RigPose = { rot, rootPos: [s.moveX ? rootPos[i][0] : 0, 0, s.moveZ ? rootPos[i][2] : 0] };
    lows.push(lowestPoint(solveFK(pose)));
    poses.push(pose);
  }
  if (s.vertical === "floor") {
    for (let i = 0; i < n; i++) poses[i].rootPos[1] = -lows[i];
  } else if (s.vertical === "video") {
    const diffs = lows.map((l, i) => -l - rootPos[i][1]).sort((a, b) => a - b);
    const c = diffs[Math.floor(diffs.length / 2)];
    for (let i = 0; i < n; i++) poses[i].rootPos[1] = Math.max(rootPos[i][1] + c, -lows[i]);
  }

  // ---- trim
  const start = Math.max(0, s.trimStart);
  const end = s.trimEnd > 0 ? s.trimEnd : Infinity;
  const out: SolvedClip = { ...empty, studsPerMetre, cameraDir: qRotate(frameRot, [0, 0, 1]) };
  let t0 = -1;
  for (let i = 0; i < n; i++) {
    const t = cap.frames[i].t;
    if (t < start - 1e-6 || t > end + 1e-6) continue;
    if (t0 < 0) t0 = t;
    out.times.push(t - t0);
    out.poses.push(poses[i]);
    out.sourceIndex.push(i);
    out.confidence.push(confidence[i]);
  }
  out.videoOffset = Math.max(0, t0);
  // Keep the start of a trimmed clip at the origin horizontally.
  if (out.poses.length) {
    const [ox, , oz] = out.poses[0].rootPos;
    for (const p of out.poses) {
      p.rootPos[0] -= ox;
      p.rootPos[2] -= oz;
    }
  }
  return out;
}
