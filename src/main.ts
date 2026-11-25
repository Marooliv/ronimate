import "./style.css";
import type { PoseLandmarker } from "@mediapipe/tasks-vision";
import { luauScript } from "./export/luau";
import { keyframeSequenceXml, rigXml } from "./export/rbxmx";
import { createLandmarker, processVideo, type ModelQuality } from "./pose/detect";
import type { Capture, CaptureFrame } from "./pose/landmarks";
import { drawOverlay } from "./preview/overlay";
import { RigViewer } from "./preview/viewer";
import { restPose } from "./rig/fk";
import { JOINT_PARTS, PRETTY_NAMES, type JointPart } from "./rig/r15";
import { buildKeyedAnim, countKeys, sampleAnim, type KeyedAnim } from "./solve/keyframes";
import { estimateLevel, solveClip, type SolvedClip } from "./solve/retarget";
import { defaultJoints, defaultSettings, type Settings } from "./solve/settings";

// ---------------------------------------------------------------- tiny DOM helpers

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = String(v);
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v as EventListener);
    else if (k in e) (e as unknown as Record<string, unknown>)[k] = v;
    else e.setAttribute(k, String(v));
  }
  e.append(...kids);
  return e;
}
function toast(msg: string) {
  const t = h("div", { class: "toast" }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}
function download(name: string, data: string, type = "application/octet-stream") {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------------------------------------------------------------- state

const STORAGE_KEY = "ronimate.settings.v1";
function loadSettings(): Settings {
  const d = defaultSettings();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return d;
    const s = JSON.parse(raw);
    return { ...d, ...s, joints: { ...defaultJoints(), ...(s.joints ?? {}) }, trimStart: 0, trimEnd: 0 };
  } catch {
    return d;
  }
}
function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable — settings just won't persist */
  }
}

const settings = loadSettings();
let capture: Capture | null = null;
let clip: SolvedClip | null = null;
let anim: KeyedAnim | null = null;
let stripConf: number[] = [];
let hasVideo = false;
let playing = false;
let clockT = 0;
let abort: AbortController | null = null;
const landmarkers = new Map<ModelQuality, PoseLandmarker>();

// ---------------------------------------------------------------- elements

const video = $<HTMLVideoElement>("#video");
const overlay = $<HTMLCanvasElement>("#overlay");
const viewer = new RigViewer($("#viewer"));
viewer.setPose(restPose());
const scrubber = $<HTMLInputElement>("#scrubber");
const playBtn = $<HTMLButtonElement>("#playBtn");
const statusEl = $("#status");
const progress = $(".progress");
const bar = $(".progress .bar");
const strip = $<HTMLCanvasElement>("#confStrip");

function setStatus(msg: string, kind: "" | "error" | "ok" = "") {
  statusEl.textContent = msg;
  statusEl.className = `status ${kind}`;
}

// ---------------------------------------------------------------- video loading

function niceName(file: string) {
  const base = file.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9]+/g, " ").trim();
  const pascal = base.split(" ").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
  return (pascal || "VideoAnimation").slice(0, 48);
}

async function loadVideo(file: File) {
  if (!file.type.startsWith("video/") && !/\.(mp4|mov|webm|mkv|m4v|avi)$/i.test(file.name)) {
    setStatus("That file doesn't look like a video.", "error");
    return;
  }
  if (video.src) URL.revokeObjectURL(video.src);
  video.src = URL.createObjectURL(file);
  hasVideo = true;
  $("#dropZone").hidden = true;
  $(".video-wrap").hidden = false;
  setStatus("Loading video…");
  try {
    await new Promise<void>((res, rej) => {
      video.onloadeddata = () => res();
      video.onerror = () => rej(new Error("decode"));
    });
  } catch {
    setStatus("This browser can't play that video. Try converting it to MP4 (H.264).", "error");
    return;
  }
  if (capture && capture.videoName !== file.name) {
    capture = null;
    clip = null;
    anim = null;
    stripConf = [];
  }
  if (!capture) {
    settings.name = niceName(file.name);
    refreshControls();
  }
  video.dataset.name = file.name;
  $<HTMLButtonElement>("#analyzeBtn").disabled = false;
  enableTransport(true);
  setStatus(`${file.name} — ${video.videoWidth}×${video.videoHeight}, ${video.duration.toFixed(1)} s. Ready to analyze.`);
  recompute();
}

for (const id of ["#videoInput", "#videoInput2"]) {
  $<HTMLInputElement>(id).addEventListener("change", (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) loadVideo(f);
    (e.target as HTMLInputElement).value = "";
  });
}
const drop = $("#videoPane");
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  $("#dropZone").classList.add("over");
});
drop.addEventListener("dragleave", () => $("#dropZone").classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  $("#dropZone").classList.remove("over");
  const f = e.dataTransfer?.files?.[0];
  if (f) loadVideo(f);
});

// ---------------------------------------------------------------- analysis

$("#analyzeBtn").addEventListener("click", async () => {
  if (!hasVideo) return;
  const q = $<HTMLSelectElement>("#modelSelect").value as ModelQuality;
  const fps = Number($<HTMLSelectElement>("#fpsSelect").value);
  abort = new AbortController();
  setBusy(true);
  try {
    let lm = landmarkers.get(q);
    if (!lm) {
      lm = await createLandmarker(q, setStatus);
      landmarkers.set(q, lm);
    }
    const started = performance.now();
    let found = 0;
    const cap = await processVideo(video, lm, video.dataset.name ?? "video", q, {
      fps,
      signal: abort.signal,
      onProgress: (done, total, frame) => {
        if (frame.world) found++;
        bar.style.width = `${(100 * done) / total}%`;
        const eta = ((performance.now() - started) / done) * (total - done) / 1000;
        setStatus(`Tracking frame ${done}/${total} · person found in ${found} · ~${Math.ceil(eta)} s left`);
        if ($<HTMLInputElement>("#overlayToggle").checked) drawOverlay(overlay, video, frame, settings.visThreshold);
      },
    });
    setCapture(cap, true);
  } catch (e) {
    if ((e as DOMException).name === "AbortError") setStatus("Analysis cancelled.");
    else {
      console.error(e);
      setStatus(`Analysis failed: ${(e as Error).message}`, "error");
    }
  } finally {
    setBusy(false);
  }
});
$("#cancelBtn").addEventListener("click", () => abort?.abort());

function setBusy(b: boolean) {
  $<HTMLButtonElement>("#analyzeBtn").disabled = b;
  $("#cancelBtn").hidden = !b;
  progress.hidden = !b;
  if (b) bar.style.width = "0%";
  enableTransport(!b);
  if (b) pause();
}

function setCapture(cap: Capture, fresh: boolean) {
  capture = cap;
  const tracked = cap.frames.filter((f) => f.world).length;
  // Camera tilt makes the whole body look like it's leaning; estimate and cancel it.
  Object.assign(settings, estimateLevel(cap));
  settings.trimStart = 0;
  settings.trimEnd = 0;
  stripConf = cap.frames.map((f) => {
    if (!f.vis) return 0;
    let s = 0;
    for (let i = 11; i < 33; i++) s += Math.min(1, f.vis[i] / 0.8);
    return s / 22;
  });
  refreshControls();
  enableTransport(true);
  $("#rigHint").textContent = "(animated)";
  if (!tracked) setStatus("No person was detected in this video.", "error");
  else
    setStatus(
      `${fresh ? "Done" : "Capture loaded"} — person tracked in ${tracked} of ${cap.frames.length} frames. Tweak on the right, then Export.`,
      "ok",
    );
  recompute();
  seekTo(0);
}

// ---------------------------------------------------------------- solving

let pending = 0;
function recompute() {
  cancelAnimationFrame(pending);
  pending = requestAnimationFrame(() => {
    saveSettings();
    if (!capture) {
      clip = null;
      anim = null;
      renderStats();
      drawStrip();
      return;
    }
    const t0 = performance.now();
    clip = solveClip(capture, settings);
    anim = clip.poses.length ? buildKeyedAnim(clip, settings.tolerance, settings.easing === "Constant") : null;
    viewer.setTrail(clip.poses.map((p) => p.rootPos));
    renderStats(performance.now() - t0);
    drawStrip();
  });
}

function renderStats(ms = 0) {
  const stats = $("#stats");
  stats.replaceChildren();
  if (!capture || !clip || !anim) return;
  const tracked = capture.frames.filter((f) => f.world).length;
  const avgConf = clip.confidence.reduce((a, b) => a + b, 0) / Math.max(1, clip.confidence.length);
  const k = countKeys(anim);
  const items: [string, string][] = [
    ["Animation length", `${anim.length.toFixed(2)} s`],
    ["Frames", `${clip.poses.length} @ ${capture.fps} fps`],
    ["Person tracked", `${Math.round((100 * tracked) / capture.frames.length)}%`],
    ["Joint confidence", `${Math.round(avgConf * 100)}%`],
    ["Keyframes", `${k.keyframes}`],
    ["Joint keys", `${k.poses}`],
    ["Scale", `${clip.studsPerMetre.toFixed(2)} studs/m`],
    ["Solve time", `${ms.toFixed(0)} ms`],
  ];
  for (const [a, b] of items) stats.append(h("div", {}, h("dt", {}, a), h("dd", {}, b)));
}

function totalDuration() {
  return capture?.duration ?? (hasVideo ? video.duration : 0) ?? 0;
}
function trimRange(): [number, number] {
  const d = totalDuration();
  return [settings.trimStart, settings.trimEnd > 0 ? settings.trimEnd : d];
}

function drawStrip() {
  const dpr = window.devicePixelRatio || 1;
  const w = strip.clientWidth, hgt = strip.clientHeight;
  strip.width = Math.max(1, Math.round(w * dpr));
  strip.height = Math.max(1, Math.round(hgt * dpr));
  const ctx = strip.getContext("2d")!;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#2b3038";
  ctx.fillRect(0, 0, w, hgt);
  const d = totalDuration();
  if (!capture || !d) return;
  const n = stripConf.length;
  for (let i = 0; i < n; i++) {
    const c = stripConf[i];
    const x0 = (capture.frames[i].t - 0.5 / capture.fps) / d * w;
    ctx.fillStyle = c > 0.6 ? "#3f9d62" : c > 0.35 ? "#c99a3e" : "#c24a4a";
    ctx.fillRect(x0, 0, w / n + 1, hgt);
  }
  const [a, b] = trimRange();
  ctx.fillStyle = "rgba(10,12,16,0.72)";
  ctx.fillRect(0, 0, (a / d) * w, hgt);
  ctx.fillRect((b / d) * w, 0, w - (b / d) * w, hgt);
}
new ResizeObserver(() => drawStrip()).observe(strip);

// ---------------------------------------------------------------- playback

function enableTransport(on: boolean) {
  const ready = on && (hasVideo || !!capture);
  for (const id of ["#playBtn", "#stepBack", "#stepFwd", "#scrubber"]) $<HTMLButtonElement>(id).disabled = !ready;
  for (const id of ["#trimStartBtn", "#trimEndBtn", "#trimReset"]) $<HTMLButtonElement>(id).disabled = !(on && capture);
}

function currentTime() {
  return hasVideo ? video.currentTime : clockT;
}
function seekTo(t: number) {
  const d = totalDuration();
  t = Math.max(0, Math.min(d || 0, t));
  if (hasVideo) video.currentTime = t;
  clockT = t;
}
function play() {
  if (playing) return;
  const [a, b] = trimRange();
  const t = currentTime();
  if (capture && (t < a || t >= b - 0.02)) seekTo(a);
  playing = true;
  playBtn.textContent = "❚❚";
  if (hasVideo) video.play().catch(() => {});
}
function pause() {
  playing = false;
  playBtn.textContent = "▶";
  if (hasVideo) video.pause();
}
playBtn.addEventListener("click", () => (playing ? pause() : play()));
const step = (dir: number) => {
  pause();
  seekTo(currentTime() + dir / (capture?.fps ?? 30));
};
$("#stepBack").addEventListener("click", () => step(-1));
$("#stepFwd").addEventListener("click", () => step(1));
scrubber.addEventListener("input", () => {
  seekTo(Number(scrubber.value) * totalDuration());
});
$("#trimStartBtn").addEventListener("click", () => {
  settings.trimStart = Math.min(currentTime(), trimRange()[1] - 0.1);
  recompute();
});
$("#trimEndBtn").addEventListener("click", () => {
  settings.trimEnd = Math.max(currentTime(), settings.trimStart + 0.1);
  recompute();
});
$("#trimReset").addEventListener("click", () => {
  settings.trimStart = 0;
  settings.trimEnd = 0;
  recompute();
});
document.addEventListener("keydown", (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  if (e.code === "Space") {
    e.preventDefault();
    if (!playBtn.disabled) playing ? pause() : play();
  } else if (e.code === "ArrowLeft") step(-1);
  else if (e.code === "ArrowRight") step(1);
});

function frameAt(t: number): CaptureFrame | null {
  if (!capture) return null;
  const i = Math.round(t * capture.fps - 0.5);
  return capture.frames[Math.max(0, Math.min(capture.frames.length - 1, i))] ?? null;
}

let lastFrameTime = performance.now();
function tick(now: number) {
  const dt = (now - lastFrameTime) / 1000;
  lastFrameTime = now;
  if (playing && !hasVideo) clockT += dt;
  let t = currentTime();
  if (playing && capture) {
    const [a, b] = trimRange();
    if (t >= b || (hasVideo && video.ended)) {
      seekTo(a);
      t = a;
      if (hasVideo) video.play().catch(() => {});
    }
  }
  const d = totalDuration();
  if (document.activeElement !== scrubber && d) scrubber.value = String(t / d);
  $("#timeLabel").textContent = `${t.toFixed(2)} / ${(d || 0).toFixed(2)} s`;

  if (anim && clip) {
    const at = Math.max(0, Math.min(anim.length, t - clip.videoOffset));
    viewer.setPose(sampleAnim(anim, at));
  }
  if (hasVideo && $<HTMLInputElement>("#overlayToggle").checked && !abort?.signal.aborted && $("#cancelBtn").hidden) {
    drawOverlay(overlay, video, frameAt(t), settings.visThreshold);
  } else if (!$<HTMLInputElement>("#overlayToggle").checked) {
    overlay.getContext("2d")!.clearRect(0, 0, overlay.width, overlay.height);
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

$<HTMLInputElement>("#followToggle").addEventListener("change", (e) => {
  viewer.follow = (e.target as HTMLInputElement).checked;
});
$("#resetCam").addEventListener("click", () => viewer.resetCamera());
$("#camView").addEventListener("click", () => {
  if (clip) viewer.viewFrom(clip.cameraDir, settings.fovDeg);
  else viewer.resetCamera();
});

// ---------------------------------------------------------------- settings UI

type Key = keyof Settings;
interface RangeDef { kind: "range"; key: Key; label: string; min: number; max: number; step: number; unit?: string; help?: string }
interface CheckDef { kind: "check"; key: Key; label: string; help?: string }
interface SelectDef { kind: "select"; key: Key; label: string; options: [string, string][]; help?: string }
interface TextDef { kind: "text"; key: Key; label: string; help?: string }
type Def = RangeDef | CheckDef | SelectDef | TextDef;

const refreshers: (() => void)[] = [];
function refreshControls() {
  refreshers.forEach((r) => r());
}

function control(d: Def): HTMLElement {
  const id = `ctl-${String(d.key)}`;
  const help = d.help ? h("div", { class: "help" }, d.help) : "";
  const changed = () => {
    recompute();
  };
  if (d.kind === "range") {
    const val = h("span", { class: "val" });
    const input = h("input", { type: "range", id, min: d.min, max: d.max, step: d.step }) as HTMLInputElement;
    const show = () => (val.textContent = `${Number(settings[d.key]).toFixed(d.step < 1 ? (d.step < 0.1 ? 2 : 1) : 0)}${d.unit ?? ""}`);
    input.addEventListener("input", () => {
      (settings as unknown as Record<string, number>)[d.key] = Number(input.value);
      show();
      changed();
    });
    refreshers.push(() => {
      input.value = String(settings[d.key]);
      show();
    });
    return h("div", { class: "field" }, h("label", { htmlFor: id }, d.label), val, input, help);
  }
  if (d.kind === "check") {
    const input = h("input", { type: "checkbox", id }) as HTMLInputElement;
    input.addEventListener("change", () => {
      (settings as unknown as Record<string, boolean>)[d.key] = input.checked;
      changed();
    });
    refreshers.push(() => (input.checked = Boolean(settings[d.key])));
    return h("div", { class: "field check" }, input, h("label", { htmlFor: id }, d.label), help);
  }
  if (d.kind === "select") {
    const sel = h("select", { id }, ...d.options.map(([v, l]) => h("option", { value: v }, l))) as HTMLSelectElement;
    sel.addEventListener("change", () => {
      (settings as unknown as Record<string, string>)[d.key] = sel.value;
      changed();
    });
    refreshers.push(() => (sel.value = String(settings[d.key])));
    return h("div", { class: "field" }, h("label", { htmlFor: id }, d.label), sel, help);
  }
  const input = h("input", { type: "text", id, class: "wide", spellcheck: false }) as HTMLInputElement;
  input.addEventListener("input", () => {
    (settings as unknown as Record<string, string>)[d.key] = input.value.replace(/[^\w ]/g, "");
    saveSettings();
  });
  refreshers.push(() => (input.value = String(settings[d.key])));
  return h("div", { class: "field" }, h("label", { htmlFor: id }, d.label), input, help);
}

function group(title: string, hint: string, ...defs: (Def | HTMLElement)[]) {
  return h(
    "section",
    { class: "group" },
    h("h3", {}, title),
    hint ? h("p", { class: "hint" }, hint) : "",
    ...defs.map((d) => (d instanceof HTMLElement ? d : control(d))),
  );
}

// Motion tab
$("#tab-motion").append(
  group(
    "Cleanup",
    "Filtering runs forwards and backwards over the whole clip, so it removes jitter without adding lag.",
    { kind: "range", key: "smoothing", label: "Smoothing", min: 0, max: 100, step: 1, help: "Higher removes more jitter; too high softens sharp hits." },
    { kind: "range", key: "responsiveness", label: "Keep fast moves sharp", min: 0, max: 100, step: 1, help: "Lets quick motions bypass smoothing." },
    { kind: "range", key: "rotSmoothing", label: "Joint rotation smoothing", min: 0, max: 4, step: 0.1, unit: " fr" },
    { kind: "range", key: "visThreshold", label: "Min. landmark visibility", min: 0, max: 0.9, step: 0.05, help: "Joints below this hold their last good pose instead of guessing." },
  ),
  group(
    "Camera & facing",
    "",
    { kind: "check", key: "mirror", label: "Video is mirrored (selfie camera)" },
    { kind: "check", key: "faceForward", label: "Start facing forward", help: "Rotates the clip so the rig starts facing Roblox forward (-Z)." },
    { kind: "range", key: "yawDeg", label: "Extra turn", min: -180, max: 180, step: 1, unit: "°" },
    { kind: "range", key: "pitchDeg", label: "Camera tilt (pitch) correction", min: -45, max: 45, step: 0.5, unit: "°" },
    { kind: "range", key: "rollDeg", label: "Camera roll correction", min: -30, max: 30, step: 0.5, unit: "°" },
    h("div", { class: "row" }, h("button", {
      class: "btn small",
      onclick: () => {
        if (!capture) return;
        Object.assign(settings, estimateLevel(capture));
        refreshControls();
        recompute();
      },
    }, "Auto-level from video")),
    { kind: "range", key: "fovDeg", label: "Camera field of view", min: 25, max: 110, step: 1, unit: "°", help: "Only affects travel distance. Phones ≈ 65–75°, webcams ≈ 60°." },
  ),
  group(
    "Root motion",
    "How the character travels. For in-place game animations turn off sideways/forward movement.",
    { kind: "check", key: "moveX", label: "Move sideways (X)" },
    { kind: "check", key: "moveZ", label: "Move forward / back (Z)" },
    { kind: "select", key: "vertical", label: "Height", options: [["floor", "Keep feet on the floor"], ["video", "From video (jumps)"], ["none", "Fixed hip height"]] },
    { kind: "range", key: "rootScale", label: "Travel distance", min: 0, max: 2, step: 0.05, unit: "×" },
    { kind: "range", key: "rootSmoothing", label: "Travel smoothing", min: 0, max: 10, step: 0.5, unit: " fr" },
  ),
  group(
    "Body",
    "",
    { kind: "range", key: "waistShare", label: "Spine bend at waist", min: 0, max: 1, step: 0.05, help: "How much of a lean happens at the Waist vs. the hips." },
    { kind: "range", key: "footTwist", label: "Feet steer leg twist", min: 0, max: 1, step: 0.05, help: "With straight legs, use foot direction to rotate the whole leg." },
  ),
);

// Joints tab
const jointRows: (() => void)[] = [];
function jointTable() {
  const tbody = h("tbody");
  for (const j of JOINT_PARTS) {
    const tw = settings.joints[j];
    const str = h("input", { type: "range", min: 0, max: 1, step: 0.05, title: "Strength" }) as HTMLInputElement;
    const offs = [0, 1, 2].map((axis) => {
      const inp = h("input", { type: "number", min: -180, max: 180, step: 1, title: `${"XYZ"[axis]} offset (°)` }) as HTMLInputElement;
      inp.addEventListener("input", () => {
        settings.joints[j].offset[axis] = Number(inp.value) || 0;
        recompute();
      });
      return inp;
    });
    const row = h("tr", {}, h("td", { class: "name" }, PRETTY_NAMES[j]), h("td", {}, str), ...offs.map((o) => h("td", {}, o)));
    str.addEventListener("input", () => {
      settings.joints[j].strength = Number(str.value);
      row.classList.toggle("dim", settings.joints[j].strength < 1);
      recompute();
    });
    const refresh = () => {
      const t = settings.joints[j] ?? tw;
      str.value = String(t.strength);
      offs.forEach((o, i) => (o.value = String(t.offset[i])));
      row.classList.toggle("dim", t.strength < 1);
    };
    jointRows.push(refresh);
    refreshers.push(refresh);
    tbody.append(row);
  }
  return h(
    "table",
    { class: "joint-table" },
    h("thead", {}, h("tr", {}, h("th", {}, "Joint"), h("th", {}, "Strength"), h("th", {}, "X°"), h("th", {}, "Y°"), h("th", {}, "Z°"))),
    tbody,
  );
}
$("#tab-joints").append(
  group(
    "Per-joint tweaks",
    "Strength blends a joint between rest (0) and the tracked motion (1). Offsets add a constant rotation about the joint's own axes — same as CFrame.Angles(X, Y, Z) in Roblox.",
    jointTable(),
    h("div", { class: "row", style: "margin-top:10px" },
      h("button", { class: "btn small", onclick: () => { settings.joints = defaultJoints(); refreshControls(); recompute(); } }, "Reset all joints"),
      h("button", {
        class: "btn small",
        title: "Hands from body tracking are rough; this locks wrists to the forearms",
        onclick: () => { settings.joints.LeftHand.strength = 0; settings.joints.RightHand.strength = 0; refreshControls(); recompute(); },
      }, "Lock wrists"),
      h("button", {
        class: "btn small",
        title: "Upper-body only clips: keep legs at rest",
        onclick: () => {
          for (const j of ["LeftUpperLeg", "LeftLowerLeg", "LeftFoot", "RightUpperLeg", "RightLowerLeg", "RightFoot"] as JointPart[]) settings.joints[j].strength = 0;
          settings.vertical = "none";
          refreshControls();
          recompute();
        },
      }, "Upper body only"),
    ),
  ),
);

// Export tab
function safeName() {
  return (settings.name || "VideoAnimation").replace(/[^\w]+/g, "_");
}
function requireAnim(): KeyedAnim | null {
  if (!anim) toast("Analyze a video first.");
  return anim;
}
$("#tab-export").append(
  group(
    "Animation",
    "",
    { kind: "text", key: "name", label: "Name" },
    { kind: "check", key: "loop", label: "Looped" },
    { kind: "select", key: "priority", label: "Priority", options: ["Core", "Idle", "Movement", "Action", "Action2", "Action3", "Action4"].map((p) => [p, p]) },
    { kind: "select", key: "easing", label: "Key easing", options: [["Linear", "Linear"], ["Cubic", "Cubic"], ["Constant", "Constant (stepped)"]], help: "Cubic eases between keys in Studio (the preview shows Linear)." },
  ),
  group(
    "Keyframes",
    "Fewer keys are easier to edit in the Animation Editor. Each joint keeps only the keys needed to stay within the tolerance.",
    { kind: "range", key: "tolerance", label: "Simplify tolerance", min: 0, max: 6, step: 0.1, unit: "°", help: "0 keeps every frame (most faithful, heaviest)." },
    { kind: "check", key: "keyAllJoints", label: "Key every joint on every keyframe", help: "Bigger file; use if another tool expects full poses." },
  ),
  group(
    "Download",
    "",
    h("div", { class: "export-buttons" },
      h("button", {
        class: "btn primary block",
        onclick: () => { const a = requireAnim(); if (a) download(`${safeName()}.rbxmx`, rigXml(a, settings), "application/xml"); },
      }, "Rig + animation", h("small", {}, ".rbxmx")),
      h("button", {
        class: "btn block",
        onclick: () => { const a = requireAnim(); if (a) download(`${safeName()}_KeyframeSequence.rbxmx`, keyframeSequenceXml(a, settings), "application/xml"); },
      }, "KeyframeSequence only", h("small", {}, ".rbxmx")),
      h("button", {
        class: "btn block",
        onclick: () => { const a = requireAnim(); if (a) download(`${safeName()}.lua`, luauScript(a, settings), "text/plain"); },
      }, "Command Bar script", h("small", {}, ".lua")),
      h("button", {
        class: "btn block",
        onclick: async () => {
          const a = requireAnim();
          if (!a) return;
          try {
            await navigator.clipboard.writeText(luauScript(a, settings));
            toast("Script copied — paste it into Studio's Command Bar.");
          } catch {
            toast("Clipboard blocked — use the download instead.");
          }
        },
      }, "Copy Command Bar script", h("small", {}, "clipboard")),
      h("button", {
        class: "btn ghost block",
        title: "Save the raw tracking so you can re-tweak later without re-analysing",
        onclick: () => {
          if (!capture) return toast("Nothing to save yet.");
          const r = (x: number) => Math.round(x * 1e5) / 1e5;
          const slim = { ...capture, frames: capture.frames.map((f) => ({ t: r(f.t), world: f.world?.map(r) ?? null, image: f.image?.map(r) ?? null, vis: f.vis?.map(r) ?? null })) };
          download(`${safeName()}.capture.json`, JSON.stringify(slim), "application/json");
        },
      }, "Save capture", h("small", {}, ".json")),
    ),
    h("p", { class: "hint", style: "margin-top:12px" }, "In Studio: right-click Workspace ▸ Insert from File… ▸ pick the .rbxmx. Then Avatar ▸ Animation Editor ▸ click the rig ▸ ⋯ ▸ Load."),
    h("button", { class: "btn ghost small", onclick: () => $<HTMLDialogElement>("#helpDialog").showModal() }, "Full instructions"),
  ),
);

// tabs
document.querySelectorAll<HTMLButtonElement>(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    document.querySelectorAll<HTMLElement>(".tab-body").forEach((b) => (b.hidden = b.id !== `tab-${tab.dataset.tab}`));
  }),
);

$("#helpBtn").addEventListener("click", () => $<HTMLDialogElement>("#helpDialog").showModal());

$<HTMLInputElement>("#captureInput").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = "";
  if (!f) return;
  try {
    const cap = JSON.parse(await f.text()) as Capture;
    if (cap.version !== 1 || !Array.isArray(cap.frames) || !cap.fps) throw new Error("not a Ronimate capture");
    if (!hasVideo) settings.name = niceName(cap.videoName || f.name);
    setCapture(cap, false);
    if (hasVideo && video.dataset.name !== cap.videoName) toast("Tip: load the matching video to see it side by side.");
  } catch (err) {
    setStatus(`Couldn't load capture: ${(err as Error).message}`, "error");
  }
});

refreshControls();
renderStats();

// Expose a small hook for automated checks.
(window as unknown as Record<string, unknown>).ronimate = {
  get capture() { return capture; },
  get anim() { return anim; },
  settings,
  setCapture,
  rigXml: () => (anim ? rigXml(anim, settings) : null),
};
