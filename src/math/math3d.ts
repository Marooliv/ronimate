// Minimal, allocation-light 3D math used by the solver, exporter and preview.
// Conventions match Roblox: right-handed, +Y up, characters face -Z.
// Quaternions are [x, y, z, w]. Rotation matrices are stored as three column
// axes (the part's RightVector, UpVector and -LookVector).

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export interface Basis {
  x: Vec3;
  y: Vec3;
  z: Vec3;
}

export const DEG = Math.PI / 180;

export const v3 = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
export const mid = (a: Vec3, b: Vec3): Vec3 => lerp3(a, b, 0.5);
export function norm(a: Vec3, fallback: Vec3 = [0, 1, 0]): Vec3 {
  const l = len(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [...fallback];
}
/** Component of `a` perpendicular to unit vector `n`. */
export const reject = (a: Vec3, n: Vec3): Vec3 => sub(a, scale(n, dot(a, n)));

// ---------------------------------------------------------------- quaternions

export const qId = (): Quat => [0, 0, 0, 1];

export function qMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export const qConj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
export const qDot = (a: Quat, b: Quat) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];

export function qNorm(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return l > 1e-12 ? [q[0] / l, q[1] / l, q[2] / l, q[3] / l] : qId();
}

export function qAxisAngle(axis: Vec3, angle: number): Quat {
  const n = norm(axis, [1, 0, 0]);
  const s = Math.sin(angle / 2);
  return [n[0] * s, n[1] * s, n[2] * s, Math.cos(angle / 2)];
}

export function qRotate(q: Quat, v: Vec3): Vec3 {
  // v' = q v q*  (optimised form)
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ];
}

export function qSlerp(a: Quat, b: Quat, t: number): Quat {
  let d = qDot(a, b);
  let bb: Quat = b;
  if (d < 0) {
    d = -d;
    bb = [-b[0], -b[1], -b[2], -b[3]];
  }
  if (d > 0.9995) {
    return qNorm([
      a[0] + (bb[0] - a[0]) * t,
      a[1] + (bb[1] - a[1]) * t,
      a[2] + (bb[2] - a[2]) * t,
      a[3] + (bb[3] - a[3]) * t,
    ]);
  }
  const th = Math.acos(Math.min(1, d));
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s;
  const wb = Math.sin(t * th) / s;
  return [
    a[0] * wa + bb[0] * wb,
    a[1] * wa + bb[1] * wb,
    a[2] * wa + bb[2] * wb,
    a[3] * wa + bb[3] * wb,
  ];
}

/** Angle in radians between two orientations. */
export function qAngle(a: Quat, b: Quat): number {
  const d = Math.min(1, Math.abs(qDot(a, b)));
  return 2 * Math.acos(d);
}

/** Shortest-arc rotation taking unit vector `a` onto unit vector `b`. */
export function qFromTo(a: Vec3, b: Vec3): Quat {
  const d = dot(a, b);
  if (d < -0.999999) {
    // 180°: pick any axis orthogonal to a
    let axis = cross([1, 0, 0], a);
    if (len(axis) < 1e-6) axis = cross([0, 1, 0], a);
    return qAxisAngle(axis, Math.PI);
  }
  const c = cross(a, b);
  return qNorm([c[0], c[1], c[2], 1 + d]);
}

export function qFromBasis(b: Basis): Quat {
  // Matrix columns are b.x, b.y, b.z
  const m00 = b.x[0], m01 = b.y[0], m02 = b.z[0];
  const m10 = b.x[1], m11 = b.y[1], m12 = b.z[1];
  const m20 = b.x[2], m21 = b.y[2], m22 = b.z[2];
  const tr = m00 + m11 + m22;
  let q: Quat;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  return qNorm(q);
}

export function qToBasis(q: Quat): Basis {
  return { x: qRotate(q, [1, 0, 0]), y: qRotate(q, [0, 1, 0]), z: qRotate(q, [0, 0, 1]) };
}

/** Row-major 3x3 rotation matrix (R00, R01, R02, R10, ... R22), as Roblox CFrames store it. */
export function qToRows(q: Quat): number[] {
  const b = qToBasis(q);
  return [b.x[0], b.y[0], b.z[0], b.x[1], b.y[1], b.z[1], b.x[2], b.y[2], b.z[2]];
}

/** Roblox CFrame.Angles(rx, ry, rz) == Rx * Ry * Rz. */
export function qFromEulerXYZ(rx: number, ry: number, rz: number): Quat {
  return qMul(qMul(qAxisAngle([1, 0, 0], rx), qAxisAngle([0, 1, 0], ry)), qAxisAngle([0, 0, 1], rz));
}

/** Inverse of qFromEulerXYZ (Roblox CFrame:ToEulerAnglesXYZ). */
export function qToEulerXYZ(q: Quat): Vec3 {
  const r = qToRows(q);
  // R = Rx Ry Rz → R02 = sin(ry)
  const sy = Math.max(-1, Math.min(1, r[2]));
  const ry = Math.asin(sy);
  let rx: number, rz: number;
  if (Math.abs(sy) < 0.99999) {
    rx = Math.atan2(-r[5], r[8]);
    rz = Math.atan2(-r[1], r[0]);
  } else {
    rx = Math.atan2(r[7], r[4]);
    rz = 0;
  }
  return [rx, ry, rz];
}

/** Gram-Schmidt: build a right-handed basis from a primary X and a secondary Y hint. */
export function basisFromXY(x: Vec3, yHint: Vec3): Basis {
  const bx = norm(x, [1, 0, 0]);
  const by = norm(reject(yHint, bx), [0, 1, 0]);
  return { x: bx, y: by, z: cross(bx, by) };
}

/** Build a right-handed basis from a primary Y and a secondary X hint. */
export function basisFromYX(y: Vec3, xHint: Vec3): Basis {
  const by = norm(y, [0, 1, 0]);
  const bx = norm(reject(xHint, by), [1, 0, 0]);
  return { x: bx, y: by, z: cross(bx, by) };
}

/** Build a right-handed basis from a primary Z and a secondary Y hint. */
export function basisFromZY(z: Vec3, yHint: Vec3): Basis {
  const bz = norm(z, [0, 0, 1]);
  const by = norm(reject(yHint, bz), [0, 1, 0]);
  return { x: cross(by, bz), y: by, z: bz };
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export function smoothstep(e0: number, e1: number, x: number) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** A rigid transform (Roblox CFrame) as rotation + position. */
export interface Xform {
  q: Quat;
  p: Vec3;
}
export const xfId = (): Xform => ({ q: qId(), p: [0, 0, 0] });
export function xfMul(a: Xform, b: Xform): Xform {
  return { q: qNorm(qMul(a.q, b.q)), p: add(a.p, qRotate(a.q, b.p)) };
}
export function xfInv(a: Xform): Xform {
  const qi = qConj(a.q);
  return { q: qi, p: scale(qRotate(qi, a.p), -1) };
}
export const xfPoint = (a: Xform, v: Vec3): Vec3 => add(a.p, qRotate(a.q, v));
