import { describe, expect, it } from "vitest";
import { luauScript } from "../src/export/luau";
import { keyframeSequenceXml, rigXml } from "../src/export/rbxmx";
import { buildKeyedAnim } from "../src/solve/keyframes";
import { solveClip } from "../src/solve/retarget";
import { defaultSettings } from "../src/solve/settings";
import { randomPose, rng, syntheticCapture } from "./synthetic";

function makeAnim(keyAll = false) {
  const rand = rng(9);
  const frames = Array.from({ length: 20 }, () => ({ rot: randomPose(rand), pos: [0, 0, 3] as [number, number, number] }));
  const s = { ...defaultSettings(), keyAllJoints: keyAll };
  return { anim: buildKeyedAnim(solveClip(syntheticCapture(frames), s), 1), s };
}

/** Minimal well-formedness check: every Item/Properties tag is balanced and nested. */
function assertBalanced(xml: string) {
  const stack: string[] = [];
  for (const m of xml.matchAll(/<(\/?)(Item|Properties|roblox)\b[^>]*>/g)) {
    if (m[1]) expect(stack.pop()).toBe(m[2]);
    else stack.push(m[2]);
  }
  expect(stack).toEqual([]);
}

describe("rbxmx export", () => {
  it("writes a balanced rig with all 16 parts, 15 Motor6Ds and AnimSaves", () => {
    const { anim, s } = makeAnim();
    const xml = rigXml(anim, s);
    assertBalanced(xml);
    expect(xml.match(/<Item class="Part"/g)!.length).toBe(16);
    expect(xml.match(/<Item class="Motor6D"/g)!.length).toBe(15);
    expect(xml).toContain('<string name="Name">AnimSaves</string>');
    expect(xml).toContain('<token name="RigType">1</token>');
  });

  it("nests poses along the Motor6D hierarchy and marks unkeyed parents with Weight 0", () => {
    const { anim, s } = makeAnim();
    const xml = keyframeSequenceXml(anim, s);
    assertBalanced(xml);
    // Head pose must sit inside UpperTorso inside LowerTorso inside HumanoidRootPart
    const kf = xml.slice(xml.indexOf('<Item class="Keyframe"'));
    const order = ["HumanoidRootPart", "LowerTorso", "UpperTorso", "Head"].map((n) => kf.indexOf(`<string name="Name">${n}</string>`));
    expect(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1]))).toBe(true);
    expect(xml).toMatch(/<float name="Weight">0<\/float>/);
    expect(xml).toMatch(/<float name="Weight">1<\/float>/);
  });

  it("key-all mode writes every joint on every keyframe", () => {
    const { anim, s } = makeAnim(true);
    const xml = keyframeSequenceXml(anim, s);
    const keyframes = xml.match(/<Item class="Keyframe"/g)!.length;
    expect(xml.match(/<Item class="Pose"/g)!.length).toBe(keyframes * 16);
  });

  it("Command Bar script embeds one data line per keyframe", () => {
    const { anim, s } = makeAnim();
    const lua = luauScript(anim, s);
    const data = lua.slice(lua.indexOf("[==[") + 5, lua.indexOf("]==]")).trim().split("\n");
    const xmlKeyframes = keyframeSequenceXml(anim, s).match(/<Item class="Keyframe"/g)!.length;
    expect(data.length).toBe(xmlKeyframes);
    expect(data[0].split("|")[1].startsWith("HumanoidRootPart,,")).toBe(true);
  });
});
