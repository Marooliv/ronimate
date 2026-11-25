import type { Vec3 } from "../math/math3d";
import { JOINT_PARTS, type JointPart } from "../rig/r15";

export interface JointTweak {
  /** 0..1 — blend between rest pose (0) and the tracked motion (1). */
  strength: number;
  /** Extra rotation in degrees, applied about the joint's own X/Y/Z (CFrame.Angles order). */
  offset: Vec3;
}

export type VerticalMode = "floor" | "video" | "none";
export type Easing = "Linear" | "Cubic" | "Constant";
export type Priority = "Idle" | "Movement" | "Action" | "Action2" | "Action3" | "Action4" | "Core";

export interface Settings {
  // --- capture cleanup
  /** 0..100 — higher = smoother landmarks (zero-phase One Euro). */
  smoothing: number;
  /** 0..100 — higher = fast motions pass through with less smoothing. */
  responsiveness: number;
  /** Gaussian sigma (frames) applied to joint rotations. */
  rotSmoothing: number;
  /** Landmarks below this visibility are treated as unreliable; the joint holds its last good pose. */
  visThreshold: number;

  // --- camera / orientation
  mirror: boolean;
  faceForward: boolean;
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
  fovDeg: number;

  // --- root motion
  moveX: boolean;
  moveZ: boolean;
  vertical: VerticalMode;
  rootScale: number;
  /** Gaussian sigma (frames) for root translation; depth gets 2× this. */
  rootSmoothing: number;

  // --- body solving
  /** 0..1 — share of forward/side spine bend given to the Waist instead of the Root. */
  waistShare: number;
  /** 0..1 — how much the feet decide leg twist when knees are straight. */
  footTwist: number;

  joints: Record<JointPart, JointTweak>;

  // --- timing
  trimStart: number;
  /** Seconds; <= 0 means "end of clip". */
  trimEnd: number;

  // --- export
  name: string;
  loop: boolean;
  priority: Priority;
  easing: Easing;
  /** Keyframe reduction tolerance in degrees (0 = keep every frame). */
  tolerance: number;
  /** Write a Pose for every joint on every keyframe (bigger file, maximum compatibility). */
  keyAllJoints: boolean;
}

export function defaultJoints(): Record<JointPart, JointTweak> {
  const j = {} as Record<JointPart, JointTweak>;
  for (const p of JOINT_PARTS) j[p] = { strength: 1, offset: [0, 0, 0] };
  return j;
}

export function defaultSettings(): Settings {
  return {
    smoothing: 45,
    responsiveness: 30,
    rotSmoothing: 0.8,
    visThreshold: 0.3,
    mirror: false,
    faceForward: true,
    yawDeg: 0,
    pitchDeg: 0,
    rollDeg: 0,
    fovDeg: 60,
    moveX: true,
    moveZ: true,
    vertical: "floor",
    rootScale: 1,
    rootSmoothing: 2,
    waistShare: 0.35,
    footTwist: 0.7,
    joints: defaultJoints(),
    trimStart: 0,
    trimEnd: 0,
    name: "VideoAnimation",
    loop: false,
    priority: "Action",
    easing: "Linear",
    tolerance: 1.0,
    keyAllJoints: false,
  };
}

export const PRIORITY_ENUM: Record<Priority, number> = {
  Idle: 0,
  Movement: 1,
  Action: 2,
  Action2: 3,
  Action3: 4,
  Action4: 5,
  Core: 1000,
};

export const EASING_ENUM: Record<Easing, number> = { Linear: 0, Constant: 1, Cubic: 3 };
