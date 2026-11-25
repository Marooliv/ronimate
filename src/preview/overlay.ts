import { SKELETON_EDGES, type CaptureFrame } from "../pose/landmarks";

/** Draws the tracked 2D skeleton over the video (respecting object-fit: contain). */
export function drawOverlay(canvas: HTMLCanvasElement, video: HTMLVideoElement, frame: CaptureFrame | null, visThreshold: number) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!frame?.image || !frame.vis || !video.videoWidth) return;

  const vr = video.videoWidth / video.videoHeight;
  let dw = w, dh = w / vr;
  if (dh > h) {
    dh = h;
    dw = h * vr;
  }
  const ox = (w - dw) / 2, oy = (h - dh) / 2;
  const px = (i: number) => ox + frame.image![i * 2] * dw;
  const py = (i: number) => oy + frame.image![i * 2 + 1] * dh;

  ctx.lineCap = "round";
  ctx.lineWidth = 3;
  for (const [a, b] of SKELETON_EDGES) {
    const v = Math.min(frame.vis[a], frame.vis[b]);
    // left side (odd indices) cyan, right side orange, centre white
    const side = a >= 11 ? (a % 2 === 1 ? "#4fd1ff" : "#ffa04f") : "#ffffff";
    ctx.strokeStyle = v < visThreshold ? "rgba(255,80,80,0.6)" : side;
    ctx.beginPath();
    ctx.moveTo(px(a), py(a));
    ctx.lineTo(px(b), py(b));
    ctx.stroke();
  }
  for (let i = 0; i < 33; i++) {
    ctx.fillStyle = frame.vis[i] < visThreshold ? "rgba(255,80,80,0.8)" : "#fff";
    ctx.beginPath();
    ctx.arc(px(i), py(i), 3, 0, Math.PI * 2);
    ctx.fill();
  }
}
