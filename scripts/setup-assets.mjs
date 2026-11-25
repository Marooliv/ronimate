// Prepares static assets the app serves itself:
//   • copies the MediaPipe WASM runtime out of node_modules
//   • downloads the pose models (lite/full/heavy) so analysis works offline
// Model download failures are non-fatal: the app falls back to Google's CDN at runtime.
import { cp, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pub = join(root, "public");

await cp(join(root, "node_modules/@mediapipe/tasks-vision/wasm"), join(pub, "mediapipe-wasm"), { recursive: true });
console.log("✓ MediaPipe wasm copied");

if (process.env.SKIP_MODELS) process.exit(0);
await mkdir(join(pub, "models"), { recursive: true });
for (const v of ["lite", "full", "heavy"]) {
  const file = join(pub, "models", `pose_landmarker_${v}.task`);
  try {
    await stat(file);
    continue;
  } catch {}
  const url = `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${v}/float16/latest/pose_landmarker_${v}.task`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(file, buf);
    console.log(`✓ pose_landmarker_${v} (${(buf.length / 1e6).toFixed(1)} MB)`);
  } catch (e) {
    console.warn(`! could not download ${v} model (${e.message}); the app will load it from the CDN instead`);
  }
}
