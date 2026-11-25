// Roblox XML model (.rbxmx) writer for the R15 rig and its KeyframeSequence.
//
// The rig file contains the animation inside `AnimSaves`, which is where
// Studio's Animation Editor looks for saved animations — so after inserting the
// file you can open the rig in the Animation Editor and every keyframe is
// editable.

import type { Quat, Vec3 } from "../math/math3d";
import { qId, qToRows } from "../math/math3d";
import { HIP_HEIGHT, JOINTS, PARTS, childrenOf, jointOffsets, type JointPart, type PartName } from "../rig/r15";
import { sampleAnim, type KeyedAnim } from "../solve/keyframes";
import { EASING_ENUM, PRIORITY_ENUM, type Settings } from "../solve/settings";

const fmt = (x: number) => {
  const r = Math.round(x * 1e6) / 1e6;
  return Object.is(r, -0) ? "0" : String(r);
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

class XmlWriter {
  private parts: string[] = [];
  private ref = 0;
  private depth = 0;
  nextRef() {
    return `RBX${(this.ref++).toString(16).toUpperCase().padStart(8, "0")}`;
  }
  line(s: string) {
    this.parts.push("\t".repeat(this.depth) + s);
  }
  open(cls: string, referent = this.nextRef()) {
    this.line(`<Item class="${cls}" referent="${referent}">`);
    this.depth++;
    this.line("<Properties>");
    this.depth++;
    return referent;
  }
  endProps() {
    this.depth--;
    this.line("</Properties>");
  }
  close() {
    this.depth--;
    this.line("</Item>");
  }
  str(name: string, v: string) {
    this.line(`<string name="${name}">${esc(v)}</string>`);
  }
  bool(name: string, v: boolean) {
    this.line(`<bool name="${name}">${v}</bool>`);
  }
  float(name: string, v: number) {
    this.line(`<float name="${name}">${fmt(v)}</float>`);
  }
  token(name: string, v: number) {
    this.line(`<token name="${name}">${v}</token>`);
  }
  refProp(name: string, v: string | null) {
    this.line(`<Ref name="${name}">${v ?? "null"}</Ref>`);
  }
  vec3(name: string, v: Vec3) {
    this.line(`<Vector3 name="${name}"><X>${fmt(v[0])}</X><Y>${fmt(v[1])}</Y><Z>${fmt(v[2])}</Z></Vector3>`);
  }
  color(name: string, [r, g, b]: [number, number, number]) {
    this.line(`<Color3uint8 name="${name}">${4278190080 + r * 65536 + g * 256 + b}</Color3uint8>`);
  }
  cframe(name: string, p: Vec3, q: Quat) {
    const r = qToRows(q).map(fmt);
    this.line(
      `<CoordinateFrame name="${name}"><X>${fmt(p[0])}</X><Y>${fmt(p[1])}</Y><Z>${fmt(p[2])}</Z>` +
        `<R00>${r[0]}</R00><R01>${r[1]}</R01><R02>${r[2]}</R02>` +
        `<R10>${r[3]}</R10><R11>${r[4]}</R11><R12>${r[5]}</R12>` +
        `<R20>${r[6]}</R20><R21>${r[7]}</R21><R22>${r[8]}</R22></CoordinateFrame>`,
    );
  }
  content(name: string, url: string) {
    this.line(`<Content name="${name}"><url>${esc(url)}</url></Content>`);
  }
  toString() {
    return [
      `<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">`,
      `\t<External>null</External>`,
      `\t<External>nil</External>`,
      ...this.parts.map((p) => "\t" + p),
      `</roblox>`,
      "",
    ].join("\n");
  }
}

// ---------------------------------------------------------------- KeyframeSequence

interface PoseValue {
  q: Quat;
  p: Vec3;
  keyed: boolean;
}

function writeKeyframeSequence(w: XmlWriter, anim: KeyedAnim, s: Settings) {
  w.open("KeyframeSequence");
  w.str("Name", s.name || "Animation");
  w.bool("Loop", s.loop);
  w.token("Priority", PRIORITY_ENUM[s.priority]);
  w.float("AuthoredHipHeight", HIP_HEIGHT);
  w.endProps();

  const times = new Set<number>();
  for (const j of Object.keys(anim.joints) as JointPart[]) anim.joints[j].t.forEach((t) => times.add(t));
  const sorted = [...times].sort((a, b) => a - b);
  const keyIndex = {} as Record<JointPart, Map<number, number>>;
  for (const j of Object.keys(anim.joints) as JointPart[]) {
    keyIndex[j] = new Map(anim.joints[j].t.map((t, i) => [t, i]));
  }
  const easing = anim.constant ? EASING_ENUM.Constant : EASING_ENUM[s.easing];

  for (const t of sorted) {
    const sampled = s.keyAllJoints ? sampleAnim(anim, t) : null;
    const values = {} as Record<JointPart, PoseValue>;
    for (const j of Object.keys(anim.joints) as JointPart[]) {
      const k = anim.joints[j];
      const idx = keyIndex[j].get(t);
      if (idx !== undefined) values[j] = { q: k.q[idx], p: k.p ? k.p[idx] : [0, 0, 0], keyed: true };
      else if (sampled) values[j] = { q: sampled.rot[j], p: j === "LowerTorso" ? sampled.rootPos : [0, 0, 0], keyed: true };
    }

    // Does `part` or any descendant have a key at this time?
    const needed = (part: PartName): boolean =>
      (part !== "HumanoidRootPart" && !!values[part as JointPart]) || childrenOf(part).some(needed);

    w.open("Keyframe");
    w.str("Name", "Keyframe");
    w.float("Time", t);
    w.endProps();
    const writePose = (part: PartName) => {
      if (!needed(part)) return;
      const v = part === "HumanoidRootPart" ? undefined : values[part as JointPart];
      w.open("Pose");
      w.str("Name", part);
      w.cframe("CFrame", v?.p ?? [0, 0, 0], v?.q ?? qId());
      // Weight 0 marks a structural parent that isn't itself keyed at this time.
      w.float("Weight", v?.keyed ? 1 : 0);
      w.token("EasingStyle", easing);
      w.token("EasingDirection", 0);
      w.endProps();
      for (const c of childrenOf(part)) writePose(c);
      w.close();
    };
    writePose("HumanoidRootPart");
    w.close();
  }
  w.close();
}

export function keyframeSequenceXml(anim: KeyedAnim, s: Settings): string {
  const w = new XmlWriter();
  writeKeyframeSequence(w, anim, s);
  return w.toString();
}

// ---------------------------------------------------------------- full rig

export function rigXml(anim: KeyedAnim | null, s: Settings): string {
  const w = new XmlWriter();
  const refs = {} as Record<PartName, string>;
  for (const name of Object.keys(PARTS) as PartName[]) refs[name] = w.nextRef();

  w.open("Model");
  w.str("Name", `${s.name || "Animation"}Rig`);
  w.refProp("PrimaryPart", refs.HumanoidRootPart);
  w.endProps();

  w.open("Humanoid");
  w.str("Name", "Humanoid");
  w.token("RigType", 1); // R15
  w.float("HipHeight", HIP_HEIGHT);
  w.token("DisplayDistanceType", 2); // None — keep the viewport clean
  w.endProps();
  w.open("Animator");
  w.str("Name", "Animator");
  w.endProps();
  w.close();
  w.close();

  for (const name of Object.keys(PARTS) as PartName[]) {
    const def = PARTS[name];
    const isRoot = name === "HumanoidRootPart";
    w.open("Part", refs[name]);
    w.str("Name", name);
    w.bool("Anchored", isRoot);
    w.bool("CanCollide", false);
    w.bool("Locked", false);
    w.cframe("CFrame", def.pos, qId());
    w.vec3("size", def.size);
    w.color("Color3uint8", def.color);
    w.float("Transparency", isRoot ? 1 : 0);
    w.token("TopSurface", 0);
    w.token("BottomSurface", 0);
    w.endProps();

    if (name === "Head") {
      w.open("SpecialMesh");
      w.str("Name", "Mesh");
      w.token("MeshType", 0); // Head
      w.vec3("Scale", [1.25, 1.25, 1.25]);
      w.endProps();
      w.close();
      w.open("Decal");
      w.str("Name", "face");
      w.content("Texture", "rbxasset://textures/face.png");
      w.token("Face", 5); // Front
      w.endProps();
      w.close();
    }

    // Rig attachments live on both parts of each joint.
    for (const j of JOINTS) {
      const { c0, c1 } = jointOffsets(j);
      if (j.part0 === name || j.part1 === name) {
        w.open("Attachment");
        w.str("Name", j.attachment);
        w.cframe("CFrame", j.part0 === name ? c0 : c1, qId());
        w.endProps();
        w.close();
      }
    }

    // The Motor6D lives in Part1, as in Roblox's own rigs.
    const joint = JOINTS.find((j) => j.part1 === name);
    if (joint) {
      const { c0, c1 } = jointOffsets(joint);
      w.open("Motor6D");
      w.str("Name", joint.motor);
      w.refProp("Part0", refs[joint.part0]);
      w.refProp("Part1", refs[joint.part1]);
      w.cframe("C0", c0, qId());
      w.cframe("C1", c1, qId());
      w.endProps();
      w.close();
    }
    w.close();
  }

  if (anim) {
    w.open("ObjectValue");
    w.str("Name", "AnimSaves");
    w.endProps();
    writeKeyframeSequence(w, anim, s);
    w.close();
  }

  w.close();
  return w.toString();
}
