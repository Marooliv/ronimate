// Per-joint keyframe reduction. Each joint keeps only the frames needed to stay
// within `tolerance` degrees of the dense solve (Ramer–Douglas–Peucker on time),
// which yields a light, hand-editable animation in Studio's Animation Editor.

import type { Quat, Vec3 } from "../math/math3d";
import { DEG, lerp3, qAngle, qSlerp, sub, len } from "../math/math3d";
import type { RigPose } from "../rig/fk";
import { JOINT_PARTS, type JointPart } from "../rig/r15";
import type { SolvedClip } from "./retarget";

export interface JointKeys {
  t: number[];
  q: Quat[];
  /** Only for LowerTorso (root translation). */
  p?: Vec3[];
}

export interface KeyedAnim {
  length: number;
  constant: boolean;
  joints: Record<JointPart, JointKeys>;
}

/** Studs of root drift allowed per degree of rotation tolerance. */
const POS_TOL_PER_DEG = 0.03;

function rdp(n: number, error: (i: number, a: number, b: number) => number, tol: number): number[] {
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    let worst = -1, worstErr = tol;
    for (let i = a + 1; i < b; i++) {
      const e = error(i, a, b);
      if (e > worstErr) {
        worstErr = e;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  const out: number[] = [];
  keep.forEach((k, i) => k && out.push(i));
  return out;
}

export function buildKeyedAnim(clip: SolvedClip, toleranceDeg: number, constant = false): KeyedAnim {
  const n = clip.poses.length;
  const length = n ? clip.times[n - 1] : 0;
  const joints = {} as Record<JointPart, JointKeys>;
  for (const j of JOINT_PARTS) {
    const qs = clip.poses.map((p) => p.rot[j]);
    const ps = j === "LowerTorso" ? clip.poses.map((p) => p.rootPos) : undefined;
    let idx: number[];
    if (toleranceDeg <= 0) idx = qs.map((_, i) => i);
    else {
      const posTol = toleranceDeg * POS_TOL_PER_DEG;
      idx = rdp(
        n,
        (i, a, b) => {
          const u = (clip.times[i] - clip.times[a]) / (clip.times[b] - clip.times[a]);
          const e = qAngle(qSlerp(qs[a], qs[b], u), qs[i]) / DEG;
          if (!ps) return e;
          const pe = len(sub(lerp3(ps[a], ps[b], u), ps[i]));
          // Express position error in "degrees" so one tolerance covers both.
          return Math.max(e, (pe / posTol) * toleranceDeg);
        },
        toleranceDeg,
      );
    }
    joints[j] = { t: idx.map((i) => clip.times[i]), q: idx.map((i) => qs[i]), p: ps && idx.map((i) => ps[i]) };
  }
  return { length, constant, joints };
}

function findSpan(ts: number[], t: number): number {
  let lo = 0, hi = ts.length - 1;
  if (t <= ts[0]) return 0;
  if (t >= ts[hi]) return hi;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (ts[m] <= t) lo = m;
    else hi = m;
  }
  return lo;
}

/** Evaluate the keyed animation at time t, interpolating like Roblox's Linear/Constant easing. */
export function sampleAnim(anim: KeyedAnim, t: number): RigPose {
  const rot = {} as Record<JointPart, Quat>;
  let rootPos: Vec3 = [0, 0, 0];
  for (const j of JOINT_PARTS) {
    const k = anim.joints[j];
    const i = findSpan(k.t, t);
    const last = i >= k.t.length - 1;
    const u = last || anim.constant ? 0 : (t - k.t[i]) / (k.t[i + 1] - k.t[i]);
    rot[j] = last ? k.q[i] : qSlerp(k.q[i], k.q[i + 1], Math.max(0, Math.min(1, u)));
    if (k.p) rootPos = last ? k.p[i] : lerp3(k.p[i], k.p[i + 1], Math.max(0, Math.min(1, u)));
  }
  return { rot, rootPos };
}

export function countKeys(anim: KeyedAnim): { poses: number; keyframes: number } {
  let poses = 0;
  const times = new Set<number>();
  for (const j of JOINT_PARTS) {
    poses += anim.joints[j].t.length;
    anim.joints[j].t.forEach((t) => times.add(t));
  }
  return { poses, keyframes: times.size };
}
