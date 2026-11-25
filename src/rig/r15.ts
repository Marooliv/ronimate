// Standard R15 rig layout (block rig proportions, scale 1).
// Every part and every Motor6D C0/C1 has identity rotation, which is also true
// of Roblox's own R15 rigs — so the joint rotations we export transfer directly
// onto any R15 avatar, not just the rig we ship.

import type { Vec3 } from "../math/math3d";
import { sub } from "../math/math3d";

export type PartName =
  | "HumanoidRootPart"
  | "LowerTorso"
  | "UpperTorso"
  | "Head"
  | "LeftUpperArm"
  | "LeftLowerArm"
  | "LeftHand"
  | "RightUpperArm"
  | "RightLowerArm"
  | "RightHand"
  | "LeftUpperLeg"
  | "LeftLowerLeg"
  | "LeftFoot"
  | "RightUpperLeg"
  | "RightLowerLeg"
  | "RightFoot";

/** Parts driven by a Motor6D (everything except the root part). */
export type JointPart = Exclude<PartName, "HumanoidRootPart">;

export interface PartDef {
  name: PartName;
  size: Vec3;
  /** Rest-pose world position of the part centre (studs). */
  pos: Vec3;
  color: [number, number, number];
}

export interface JointDef {
  /** Motor6D name, e.g. "LeftShoulder" */
  motor: string;
  part0: PartName;
  part1: JointPart;
  /** Rest-pose world position of the joint pivot. */
  pivot: Vec3;
  /** Rig attachment name used by Humanoid:BuildRigFromAttachments. */
  attachment: string;
}

const YELLOW: [number, number, number] = [245, 205, 48];
const BLUE: [number, number, number] = [13, 105, 172];
const GREEN: [number, number, number] = [75, 151, 75];
const GREY: [number, number, number] = [163, 162, 165];

export const HIP_HEIGHT = 2;

export const PARTS: Record<PartName, PartDef> = {
  HumanoidRootPart: { name: "HumanoidRootPart", size: [2, 2, 1], pos: [0, 3, 0], color: GREY },
  LowerTorso: { name: "LowerTorso", size: [2, 0.4, 1], pos: [0, 2.91, 0], color: BLUE },
  UpperTorso: { name: "UpperTorso", size: [2, 1.6, 1], pos: [0, 3.91, 0], color: BLUE },
  // Head part is (2,1,1) with a classic head SpecialMesh scaled 1.25 → ~1.25 stud head
  Head: { name: "Head", size: [2, 1, 1], pos: [0, 5.31, 0], color: YELLOW },

  LeftUpperArm: { name: "LeftUpperArm", size: [1, 1.169, 1], pos: [-1.5, 4.079, 0], color: YELLOW },
  LeftLowerArm: { name: "LeftLowerArm", size: [1, 1.052, 1], pos: [-1.5, 2.974, 0], color: YELLOW },
  LeftHand: { name: "LeftHand", size: [1, 0.3, 1], pos: [-1.5, 2.298, 0], color: YELLOW },
  RightUpperArm: { name: "RightUpperArm", size: [1, 1.169, 1], pos: [1.5, 4.079, 0], color: YELLOW },
  RightLowerArm: { name: "RightLowerArm", size: [1, 1.052, 1], pos: [1.5, 2.974, 0], color: YELLOW },
  RightHand: { name: "RightHand", size: [1, 0.3, 1], pos: [1.5, 2.298, 0], color: YELLOW },

  LeftUpperLeg: { name: "LeftUpperLeg", size: [1, 1.217, 1], pos: [-0.5, 2.1015, 0], color: GREEN },
  LeftLowerLeg: { name: "LeftLowerLeg", size: [1, 1.193, 1], pos: [-0.5, 0.8965, 0], color: GREEN },
  LeftFoot: { name: "LeftFoot", size: [1, 0.3, 1], pos: [-0.5, 0.15, 0], color: GREEN },
  RightUpperLeg: { name: "RightUpperLeg", size: [1, 1.217, 1], pos: [0.5, 2.1015, 0], color: GREEN },
  RightLowerLeg: { name: "RightLowerLeg", size: [1, 1.193, 1], pos: [0.5, 0.8965, 0], color: GREEN },
  RightFoot: { name: "RightFoot", size: [1, 0.3, 1], pos: [0.5, 0.15, 0], color: GREEN },
};

/** Joints in parent-before-child order. */
export const JOINTS: JointDef[] = [
  { motor: "Root", part0: "HumanoidRootPart", part1: "LowerTorso", pivot: [0, 2.71, 0], attachment: "RootRigAttachment" },
  { motor: "Waist", part0: "LowerTorso", part1: "UpperTorso", pivot: [0, 3.11, 0], attachment: "WaistRigAttachment" },
  { motor: "Neck", part0: "UpperTorso", part1: "Head", pivot: [0, 4.71, 0], attachment: "NeckRigAttachment" },

  { motor: "LeftShoulder", part0: "UpperTorso", part1: "LeftUpperArm", pivot: [-1, 4.473, 0], attachment: "LeftShoulderRigAttachment" },
  { motor: "LeftElbow", part0: "LeftUpperArm", part1: "LeftLowerArm", pivot: [-1.5, 3.5, 0], attachment: "LeftElbowRigAttachment" },
  { motor: "LeftWrist", part0: "LeftLowerArm", part1: "LeftHand", pivot: [-1.5, 2.448, 0], attachment: "LeftWristRigAttachment" },
  { motor: "RightShoulder", part0: "UpperTorso", part1: "RightUpperArm", pivot: [1, 4.473, 0], attachment: "RightShoulderRigAttachment" },
  { motor: "RightElbow", part0: "RightUpperArm", part1: "RightLowerArm", pivot: [1.5, 3.5, 0], attachment: "RightElbowRigAttachment" },
  { motor: "RightWrist", part0: "RightLowerArm", part1: "RightHand", pivot: [1.5, 2.448, 0], attachment: "RightWristRigAttachment" },

  { motor: "LeftHip", part0: "LowerTorso", part1: "LeftUpperLeg", pivot: [-0.5, 2.71, 0], attachment: "LeftHipRigAttachment" },
  { motor: "LeftKnee", part0: "LeftUpperLeg", part1: "LeftLowerLeg", pivot: [-0.5, 1.493, 0], attachment: "LeftKneeRigAttachment" },
  { motor: "LeftAnkle", part0: "LeftLowerLeg", part1: "LeftFoot", pivot: [-0.5, 0.3, 0], attachment: "LeftAnkleRigAttachment" },
  { motor: "RightHip", part0: "LowerTorso", part1: "RightUpperLeg", pivot: [0.5, 2.71, 0], attachment: "RightHipRigAttachment" },
  { motor: "RightKnee", part0: "RightUpperLeg", part1: "RightLowerLeg", pivot: [0.5, 1.493, 0], attachment: "RightKneeRigAttachment" },
  { motor: "RightAnkle", part0: "RightLowerLeg", part1: "RightFoot", pivot: [0.5, 0.3, 0], attachment: "RightAnkleRigAttachment" },
];

export const JOINT_PARTS: JointPart[] = JOINTS.map((j) => j.part1);
export const JOINT_BY_PART = Object.fromEntries(JOINTS.map((j) => [j.part1, j])) as Record<JointPart, JointDef>;

/** Motor6D C0 / C1 offsets (identity rotation, so just positions). */
export function jointOffsets(j: JointDef): { c0: Vec3; c1: Vec3 } {
  return { c0: sub(j.pivot, PARTS[j.part0].pos), c1: sub(j.pivot, PARTS[j.part1].pos) };
}

/** Children lists, used to build the nested Pose hierarchy. */
export function childrenOf(part: PartName): JointPart[] {
  return JOINTS.filter((j) => j.part0 === part).map((j) => j.part1);
}

/** R15 hip-to-ankle length, used to scale real-world metres to studs. */
export const RIG_LEG_LENGTH = PARTS.LeftUpperLeg.pos[1] + PARTS.LeftUpperLeg.size[1] / 2 - 0.3; // 2.41

export const PRETTY_NAMES: Record<JointPart, string> = {
  LowerTorso: "Hips (Root)",
  UpperTorso: "Chest (Waist)",
  Head: "Head (Neck)",
  LeftUpperArm: "L Shoulder",
  LeftLowerArm: "L Elbow",
  LeftHand: "L Wrist",
  RightUpperArm: "R Shoulder",
  RightLowerArm: "R Elbow",
  RightHand: "R Wrist",
  LeftUpperLeg: "L Hip",
  LeftLowerLeg: "L Knee",
  LeftFoot: "L Ankle",
  RightUpperLeg: "R Hip",
  RightLowerLeg: "R Knee",
  RightFoot: "R Ankle",
};
