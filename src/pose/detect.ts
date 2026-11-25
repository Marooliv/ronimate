// Runs MediaPipe Pose Landmarker over every frame of a video, entirely in the browser.

import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";
import type { Capture, CaptureFrame } from "./landmarks";

export type ModelQuality = "lite" | "full" | "heavy";

const BASE = import.meta.env.BASE_URL;
const cdnModel = (q: ModelQuality) =>
  `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${q}/float16/latest/pose_landmarker_${q}.task`;

async function modelUrl(q: ModelQuality): Promise<string> {
  const local = `${BASE}models/pose_landmarker_${q}.task`;
  try {
    const res = await fetch(local, { method: "HEAD" });
    const type = res.headers.get("content-type") ?? "";
    if (res.ok && !type.includes("text/html")) return local;
  } catch {
    /* fall through to CDN */
  }
  return cdnModel(q);
}

export async function createLandmarker(q: ModelQuality, onStatus: (s: string) => void): Promise<PoseLandmarker> {
  onStatus("Loading pose engine…");
  const fileset = await FilesetResolver.forVisionTasks(`${BASE}mediapipe-wasm`);
  const modelAssetPath = await modelUrl(q);
  onStatus(`Loading ${q} pose model…`);
  const opts = (delegate: "GPU" | "CPU") => ({
    baseOptions: { modelAssetPath, delegate },
    runningMode: "VIDEO" as const,
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try {
    return await PoseLandmarker.createFromOptions(fileset, opts("GPU"));
  } catch (e) {
    console.warn("GPU delegate unavailable, using CPU", e);
    return await PoseLandmarker.createFromOptions(fileset, opts("CPU"));
  }
}

// VIDEO-mode timestamps must keep increasing for the lifetime of a landmarker,
// even across separate analyses, so keep a module-wide clock.
let lastTimestamp = 0;

function seek(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - t) < 1e-4 && video.readyState >= 2) return resolve();
    const done = () => {
      video.removeEventListener("seeked", done);
      resolve();
    };
    video.addEventListener("seeked", done);
    video.currentTime = t;
  });
}

export interface ProcessOptions {
  fps: number;
  /** Longest side of the frame fed to the model (larger = slower, slightly more precise). */
  maxSide?: number;
  onProgress?: (done: number, total: number, frame: CaptureFrame) => void;
  signal?: AbortSignal;
}

/** Seek through the video frame by frame and track the pose on each one. */
export async function processVideo(
  video: HTMLVideoElement, landmarker: PoseLandmarker, name: string, model: string, o: ProcessOptions,
): Promise<Capture> {
  const duration = video.duration;
  const total = Math.max(1, Math.floor(duration * o.fps + 1e-6));
  const maxSide = o.maxSide ?? 1280;
  const k = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(video.videoWidth * k);
  canvas.height = Math.round(video.videoHeight * k);
  const ctx = canvas.getContext("2d", { willReadFrequently: false })!;
  const frames: CaptureFrame[] = [];
  video.pause();
  const tsBase = lastTimestamp + 1000;

  for (let i = 0; i < total; i++) {
    if (o.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    // Sample the middle of each output frame interval to avoid landing on frame boundaries.
    const t = Math.min(duration - 1e-3, (i + 0.5) / o.fps);
    await seek(video, t);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    lastTimestamp = tsBase + Math.round((i * 1000) / o.fps);
    const res = landmarker.detectForVideo(canvas, lastTimestamp);
    const lm = res.landmarks[0];
    const wl = res.worldLandmarks[0];
    const frame: CaptureFrame = lm && wl
      ? {
          t,
          world: wl.flatMap((p) => [p.x, p.y, p.z]),
          image: lm.flatMap((p) => [p.x, p.y]),
          vis: lm.map((p) => p.visibility ?? 1),
        }
      : { t, world: null, image: null, vis: null };
    frames.push(frame);
    o.onProgress?.(i + 1, total, frame);
    // Yield so the UI can repaint.
    if (i % 2 === 0) await new Promise((r) => setTimeout(r, 0));
  }

  return {
    version: 1,
    videoName: name,
    width: video.videoWidth,
    height: video.videoHeight,
    fps: o.fps,
    duration,
    model,
    frames,
  };
}
