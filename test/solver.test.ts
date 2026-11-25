import { describe, expect, it } from "vitest";
import { DEG, qAngle, qAxisAngle, qFromEulerXYZ, qRotate, qToEulerXYZ, type Vec3 } from "../src/math/math3d";
import { lowestPoint, restPose, solveFK } from "../src/rig/fk";
import { JOINT_PARTS } from "../src/rig/r15";
import { buildKeyedAnim, sampleAnim } from "../src/solve/keyframes";
import { estimateLevel, solveClip, solveTranslation, solveWorldOrientations, worldToLocal } from "../src/solve/retarget";
import { defaultSettings } from "../src/solve/settings";
import { identityLocals, randomPose, rng, skeletonLandmarks, syntheticCapture } from "./synthetic";

const deg = (rad: number) => rad / DEG;

describe("math", () => {
  it("Euler XYZ round-trips like CFrame.Angles", () => {
    const q = qFromEulerXYZ(0.3, -0.7, 1.1);
    const [x, y, z] = qToEulerXYZ(q);
    expect(qAngle(q, qFromEulerXYZ(x, y, z))).toBeLessThan(1e-9);
  });
});

describe("rig", () => {
  it("rest pose stands exactly on the floor", () => {
    expect(lowestPoint(solveFK(restPose()))).toBeCloseTo(0, 6);
  });
});

describe("pose solver (single frame)", () => {
  it("rest landmarks produce identity joints", () => {
    const local = worldToLocal(solveWorldOrientations(skeletonLandmarks(identityLocals()), { waistShare: 0, footTwist: 0.7 }));
    for (const j of JOINT_PARTS) expect(deg(qAngle(local[j], [0, 0, 0, 1]))).toBeLessThan(1e-6);
  });

  it("recovers random poses with bent elbows and knees exactly", () => {
    const rand = rng(42);
    let worst = 0;
    for (let n = 0; n < 200; n++) {
      const truth = randomPose(rand);
      const local = worldToLocal(solveWorldOrientations(skeletonLandmarks(truth), { waistShare: 0, footTwist: 0.7 }));
      for (const j of JOINT_PARTS) worst = Math.max(worst, deg(qAngle(local[j], truth[j])));
    }
    expect(worst).toBeLessThan(0.01);
  });

  it("straight limbs still point exactly the right way", () => {
    const rand = rng(7);
    for (let n = 0; n < 100; n++) {
      const truth = randomPose(rand);
      truth.LeftLowerArm = truth.RightLowerArm = [0, 0, 0, 1];
      truth.LeftLowerLeg = truth.RightLowerLeg = [0, 0, 0, 1];
      const P = skeletonLandmarks(truth);
      const world = solveWorldOrientations(P, { waistShare: 0, footTwist: 0.7 });
      const local = worldToLocal(world);
      // bone direction in parent space must match even though twist is ambiguous
      for (const j of ["LeftUpperArm", "RightUpperArm", "LeftUpperLeg", "RightUpperLeg"] as const) {
        const a = qRotate(local[j], [0, 1, 0]);
        const b = qRotate(truth[j], [0, 1, 0]);
        const err = deg(Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
        expect(err).toBeLessThan(0.01);
      }
    }
  });
});

describe("camera translation", () => {
  it("recovers the hip position from 2D + 3D landmarks", () => {
    const pos: Vec3 = [0.4, -0.2, 3.5];
    const cap = syntheticCapture([{ rot: randomPose(rng(3)), pos }]);
    const fr = cap.frames[0];
    const world: Vec3[] = [];
    for (let i = 0; i < 33; i++) world.push([fr.world![i * 3], fr.world![i * 3 + 1], fr.world![i * 3 + 2]]);
    const t = solveTranslation(world, fr.image!, fr.vis!, cap.width, cap.height, 60)!;
    expect(t[0]).toBeCloseTo(pos[0], 4);
    expect(t[1]).toBeCloseTo(pos[1], 4);
    expect(t[2]).toBeCloseTo(pos[2], 4);
  });
});

describe("full clip", () => {
  const rand = rng(11);
  const poseA = randomPose(rand);
  const n = 60;
  // Subject walks 1 m to their right (image left) and 1 m away while holding a pose, facing the camera.
  const frames = Array.from({ length: n }, (_, i) => ({ rot: poseA, pos: [-i / (n - 1), 0, 3 + i / (n - 1)] as Vec3 }));
  const cap = syntheticCapture(frames);
  const s = { ...defaultSettings(), faceForward: false, waistShare: 0, rotSmoothing: 0, vertical: "none" as const };

  it("reproduces joint rotations through the whole pipeline", () => {
    const clip = solveClip(cap, s);
    expect(clip.poses.length).toBe(n);
    let worst = 0;
    for (const p of clip.poses) for (const j of JOINT_PARTS) worst = Math.max(worst, deg(qAngle(p.rot[j], poseA[j])));
    expect(worst).toBeLessThan(0.05);
  });

  it("converts camera motion into root motion in studs", () => {
    const clip = solveClip(cap, s);
    const last = clip.poses[n - 1].rootPos;
    const k = clip.studsPerMetre;
    // MediaPipe -x (image left) is the subject's right → Roblox +X; further away → +Z (backwards)
    expect(last[0]).toBeCloseTo(1 * k, 2);
    expect(last[2]).toBeCloseTo(1 * k, 2);
    expect(k).toBeGreaterThan(2);
    expect(k).toBeLessThan(4);
  });

  it("floor mode keeps the lowest point on the ground", () => {
    const clip = solveClip(cap, { ...s, vertical: "floor" });
    for (const p of clip.poses) expect(lowestPoint(solveFK(p))).toBeCloseTo(0, 5);
  });

  it("face-forward removes the initial heading", () => {
    const turned = { ...poseA, LowerTorso: qAxisAngle([0, 1, 0], 70 * DEG) };
    const c = syntheticCapture([{ rot: turned, pos: [0, 0, 3] }, { rot: turned, pos: [0, 0, 3] }]);
    const clip = solveClip(c, { ...s, faceForward: true });
    const x = qRotate(clip.poses[0].rot.LowerTorso, [1, 0, 0]);
    expect(Math.abs(x[2])).toBeLessThan(0.05);
  });

  it("auto-level detects camera pitch", () => {
    const tilt = 12 * DEG;
    const upright = identityLocals();
    upright.LowerTorso = qAxisAngle([1, 0, 0], -tilt); // whole body appears leaned by camera tilt
    const c = syntheticCapture([{ rot: upright, pos: [0, 0, 3] }]);
    const { pitchDeg } = estimateLevel(c);
    expect(Math.abs(pitchDeg - 12)).toBeLessThan(1.5);
  });
});

describe("keyframe reduction", () => {
  it("stays within tolerance of the dense solve and drops most keys", () => {
    const rand = rng(5);
    const a = randomPose(rand), b = randomPose(rand);
    const n = 90;
    const frames = Array.from({ length: n }, (_, i) => {
      const u = 0.5 - 0.5 * Math.cos((Math.PI * i) / (n - 1));
      const rot = identityLocals();
      for (const j of JOINT_PARTS) {
        const ea = qToEulerXYZ(a[j]), eb = qToEulerXYZ(b[j]);
        rot[j] = qFromEulerXYZ(ea[0] + (eb[0] - ea[0]) * u, ea[1] + (eb[1] - ea[1]) * u, ea[2] + (eb[2] - ea[2]) * u);
      }
      return { rot, pos: [Math.sin(i / 10) * 0.3, 0, 3] as Vec3 };
    });
    const clip = solveClip(syntheticCapture(frames), { ...defaultSettings(), faceForward: false });
    const tol = 1.5;
    const anim = buildKeyedAnim(clip, tol);
    let worst = 0, keys = 0;
    for (const j of JOINT_PARTS) keys += anim.joints[j].t.length;
    clip.poses.forEach((p, i) => {
      const s = sampleAnim(anim, clip.times[i]);
      for (const j of JOINT_PARTS) worst = Math.max(worst, deg(qAngle(s.rot[j], p.rot[j])));
    });
    expect(worst).toBeLessThanOrEqual(tol + 1e-6);
    expect(keys).toBeLessThan(JOINT_PARTS.length * n * 0.4);
  });
});
