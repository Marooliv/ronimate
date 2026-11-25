// MediaPipe BlazePose 33-landmark topology.
export const LM = {
  nose: 0,
  leftEyeInner: 1,
  leftEye: 2,
  leftEyeOuter: 3,
  rightEyeInner: 4,
  rightEye: 5,
  rightEyeOuter: 6,
  leftEar: 7,
  rightEar: 8,
  mouthLeft: 9,
  mouthRight: 10,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftPinky: 17,
  rightPinky: 18,
  leftIndex: 19,
  rightIndex: 20,
  leftThumb: 21,
  rightThumb: 22,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
  leftHeel: 29,
  rightHeel: 30,
  leftFootIndex: 31,
  rightFootIndex: 32,
} as const;

export const NUM_LANDMARKS = 33;

/** Index map that swaps every left landmark with its right counterpart. */
export const MIRROR_MAP: number[] = (() => {
  const m = Array.from({ length: NUM_LANDMARKS }, (_, i) => i);
  const pairs: [number, number][] = [
    [1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 18], [19, 20],
    [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32],
  ];
  for (const [a, b] of pairs) {
    m[a] = b;
    m[b] = a;
  }
  return m;
})();

export const SKELETON_EDGES: [number, number][] = [
  [11, 12], [11, 23], [12, 24], [23, 24],
  [11, 13], [13, 15], [15, 17], [15, 19], [17, 19], [15, 21],
  [12, 14], [14, 16], [16, 18], [16, 20], [18, 20], [16, 22],
  [23, 25], [25, 27], [27, 29], [29, 31], [27, 31],
  [24, 26], [26, 28], [28, 30], [30, 32], [28, 32],
  [7, 2], [2, 0], [0, 5], [5, 8], [9, 10],
];

/** Raw per-frame tracking result, stored compactly so captures can be saved as JSON. */
export interface CaptureFrame {
  /** Seconds from the start of the video. */
  t: number;
  /** 33×3 MediaPipe world landmarks in metres (x right, y down, z away from camera), or null if no person. */
  world: number[] | null;
  /** 33×2 normalised image coordinates (0..1). */
  image: number[] | null;
  /** 33 visibility scores (0..1). */
  vis: number[] | null;
}

export interface Capture {
  version: 1;
  videoName: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  model: string;
  frames: CaptureFrame[];
}
