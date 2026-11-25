# Ronimate

Turn a video of a person into an **editable Roblox Studio R15 animation**, ready to load in the Animation Editor.

Everything runs in your browser. The video is never uploaded.

![pipeline](https://img.shields.io/badge/video-%E2%86%92%20pose%20tracking%20%E2%86%92%20R15%20solve%20%E2%86%92%20.rbxmx-3d8bff)

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
```

`npm run dev` and `npm run build` first run `scripts/setup-assets.mjs`. That script copies the MediaPipe WASM runtime and downloads the three pose models (about 46 MB) into `public/`. If the download fails, the app loads the models from Google's CDN at runtime instead.

1. **Drop a video.** One person, whole body visible, steady camera.
2. **Analyze.** MediaPipe Pose Landmarker (Heavy by default) tracks 33 body landmarks in 3D on every frame.
3. **Tweak.** Use the side panel to change smoothing, camera tilt, root motion and per-joint offsets. The 3D preview updates live, next to the video with its skeleton overlay.
4. **Export.**
   - **Rig + animation (.rbxmx):** an R15 rig with the animation saved in its `AnimSaves` folder.
   - **KeyframeSequence only (.rbxmx):** just the animation, to drop into your own rig's `AnimSaves`.
   - **Command Bar script (.lua):** paste it into Studio's Command Bar. It adds the animation to the selected R15 model, or builds a rig if nothing is selected.
   - **Save capture (.json):** the raw tracking data. Load it later to re-tweak without analyzing the video again.

### In Roblox Studio

1. Right-click **Workspace** ▸ **Insert from File…** ▸ pick the `.rbxmx` file.
2. Open **Avatar ▸ Animation Editor**, click the rig, then **⋯ ▸ Load** and pick the animation.
3. Edit any keyframe, then **Publish to Roblox** to get an Animation ID.

## How it works

| Stage | File | Notes |
| --- | --- | --- |
| Pose tracking | `src/pose/detect.ts` | Seeks through the video frame by frame. Runs MediaPipe `PoseLandmarker` in VIDEO mode, on the GPU when available and the CPU otherwise. |
| Cleanup | `src/solve/filter.ts` | Zero-phase One Euro filter: it runs forwards and backwards and averages the two passes, so there's no lag. Gaps are interpolated. |
| Retargeting | `src/solve/retarget.ts` | Solves each R15 part's **world** orientation from the landmarks, then local = parent⁻¹ · child. |
| Root motion | `src/solve/retarget.ts` | Fits the metric 3D skeleton to the 2D detections with a pinhole camera to recover hip travel. Scales metres to studs using the subject's leg length. Floor contact is computed with real Motor6D forward kinematics. |
| Keyframes | `src/solve/keyframes.ts` | Per-joint Ramer–Douglas–Peucker reduction within a degree tolerance. The result is a light animation you can edit by hand. |
| Export | `src/export/rbxmx.ts`, `src/export/luau.ts` | Writes the Roblox XML model / KeyframeSequence and the Command Bar script. |

How each part's orientation is found:

- **Pelvis, chest and head** get a full 3D frame from 3+ landmarks: hip line + spine, shoulder line + spine, ear line + eye→mouth.
- **Upper and lower limbs** take their direction from the bone. Twist comes from the elbow or knee hinge when the joint is bent. When the leg is straight, the foot's heading steers the twist. When the arm is straight, twist is kept minimal relative to the parent.
- **Hands** use the wrist, index and pinky landmarks. **Feet** use the ankle, heel and toe landmarks.
- Joints whose landmarks are poorly visible hold their last confident pose instead of guessing.

Every R15 Motor6D `C0`/`C1` has identity rotation, both in this rig and in Roblox's own R15 rigs. So the exported `Pose.CFrame` rotations transfer directly onto any R15 avatar.

## Tests

```bash
npm test
```

The tests pose a synthetic skeleton with known joint rotations, generate MediaPipe-style landmarks and a camera projection from it, and check what the solver gets back:

- Random poses with bent limbs: joint rotations come back within 0.01°.
- Straight limbs: bone directions come back exactly.
- Camera translation, face-forward and floor contact all work.
- Auto-level finds camera tilt.
- Keyframe reduction stays within its tolerance.

## Limits

- Accuracy is bounded by single-camera tracking. Depth (toward/away from the camera) is the weakest axis, and pure side views are hardest.
- MediaPipe's body model doesn't track fingers, and wrist rotation from it is approximate. Use **Joints ▸ Lock wrists** if the hands look noisy.
- One person per video.
