import type { Quat, Vec3, Xform } from "../math/math3d";
import { qId, xfMul, xfInv, xfPoint } from "../math/math3d";
import { JOINTS, PARTS, jointOffsets, type JointPart, type PartName } from "./r15";

/** One sampled pose: Motor6D.Transform for every joint (rotation) plus root translation. */
export interface RigPose {
  rot: Record<JointPart, Quat>;
  /** Root (LowerTorso) Transform translation in studs, HumanoidRootPart space. */
  rootPos: Vec3;
}

const OFFSETS = JOINTS.map((j) => {
  const { c0, c1 } = jointOffsets(j);
  return { j, c0: { q: qId(), p: c0 } as Xform, c1Inv: xfInv({ q: qId(), p: c1 }) };
});

export function restPose(): RigPose {
  const rot = {} as Record<JointPart, Quat>;
  for (const j of JOINTS) rot[j.part1] = qId();
  return { rot, rootPos: [0, 0, 0] };
}

/**
 * Forward kinematics, exactly as Roblox evaluates Motor6Ds:
 *   Part1.CFrame = Part0.CFrame * C0 * Transform * C1:Inverse()
 */
export function solveFK(pose: RigPose, root: Xform = { q: qId(), p: PARTS.HumanoidRootPart.pos }): Record<PartName, Xform> {
  const out = { HumanoidRootPart: root } as Record<PartName, Xform>;
  for (const { j, c0, c1Inv } of OFFSETS) {
    const t: Xform = { q: pose.rot[j.part1], p: j.part1 === "LowerTorso" ? pose.rootPos : [0, 0, 0] };
    out[j.part1] = xfMul(xfMul(xfMul(out[j.part0], c0), t), c1Inv);
  }
  return out;
}

/** Lowest world-space Y of any visible part's box corners. */
export function lowestPoint(world: Record<PartName, Xform>): number {
  let min = Infinity;
  for (const name of Object.keys(world) as PartName[]) {
    if (name === "HumanoidRootPart") continue;
    const [sx, sy, sz] = PARTS[name].size;
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    // Hands and feet dominate contact; using all 8 corners is cheap enough.
    for (const cx of [-hx, hx])
      for (const cy of [-hy, hy])
        for (const cz of [-hz, hz]) {
          const y = xfPoint(world[name], [cx, cy, cz])[1];
          if (y < min) min = y;
        }
  }
  return min;
}
