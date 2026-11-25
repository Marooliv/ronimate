import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { solveFK, type RigPose } from "../rig/fk";
import { PARTS, type PartName } from "../rig/r15";

export class RigViewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private meshes = new Map<PartName, THREE.Object3D>();
  private trail: THREE.Line;
  private shadowTarget = new THREE.Object3D();
  private light: THREE.DirectionalLight;
  follow = true;
  private lastRoot = new THREE.Vector3(0, 3, 0);

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    host.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 500);
    this.camera.position.set(8, 6.5, -15);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 3, 0);
    this.controls.enableDamping = true;

    this.scene.background = new THREE.Color(0x1b1e24);
    this.scene.fog = new THREE.Fog(0x1b1e24, 40, 90);
    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a3226, 1.4));
    this.light = new THREE.DirectionalLight(0xffffff, 2.2);
    this.light.position.set(6, 14, -8);
    this.light.castShadow = true;
    this.light.shadow.mapSize.set(2048, 2048);
    const sc = this.light.shadow.camera;
    sc.left = sc.bottom = -8;
    sc.right = sc.top = 8;
    this.light.target = this.shadowTarget;
    this.scene.add(this.light, this.shadowTarget);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 1 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);
    const grid = new THREE.GridHelper(200, 100, 0x4a5262, 0x363c47);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.6;
    grid.position.y = 0.002;
    this.scene.add(grid);

    // Forward arrow at the origin: Roblox characters face -Z.
    const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0.01, 0), 2, 0x6aa8ff, 0.4, 0.25);
    this.scene.add(arrow);

    this.trail = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffb454, transparent: true, opacity: 0.7 }));
    this.scene.add(this.trail);

    this.buildRig();
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  private buildRig() {
    for (const name of Object.keys(PARTS) as PartName[]) {
      if (name === "HumanoidRootPart") continue;
      const def = PARTS[name];
      const color = new THREE.Color(`rgb(${def.color.join(",")})`);
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05 });
      let mesh: THREE.Object3D;
      if (name === "Head") {
        const g = new THREE.Group();
        const head = new THREE.Mesh(new RoundedBoxGeometry(1.2, 1.2, 1.2, 4, 0.35), mat);
        head.castShadow = true;
        g.add(head);
        // Face on the -Z side so it's obvious which way the rig looks.
        const dark = new THREE.MeshBasicMaterial({ color: 0x111111 });
        for (const x of [-0.22, 0.22]) {
          const eye = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.12, 4, 8), dark);
          eye.position.set(x, 0.12, -0.61);
          g.add(eye);
        }
        const smile = new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.035, 6, 20, Math.PI * 0.8), dark);
        smile.position.set(0, -0.1, -0.61);
        smile.rotation.z = Math.PI + Math.PI * 0.1;
        g.add(smile);
        mesh = g;
      } else {
        const [sx, sy, sz] = def.size;
        const m = new THREE.Mesh(new RoundedBoxGeometry(sx, sy, sz, 2, Math.min(0.08, sy / 4)), mat);
        m.castShadow = true;
        m.receiveShadow = true;
        mesh = m;
      }
      this.scene.add(mesh);
      this.meshes.set(name, mesh);
    }
  }

  setPose(pose: RigPose) {
    const world = solveFK(pose);
    for (const [name, mesh] of this.meshes) {
      const x = world[name];
      mesh.position.set(x.p[0], x.p[1], x.p[2]);
      mesh.quaternion.set(x.q[0], x.q[1], x.q[2], x.q[3]);
    }
    const lt = world.LowerTorso.p;
    const root = new THREE.Vector3(lt[0], 3, lt[2]);
    if (this.follow) {
      const d = root.clone().sub(this.lastRoot);
      this.controls.target.add(d);
      this.camera.position.add(d);
    }
    this.lastRoot.copy(root);
    this.shadowTarget.position.set(lt[0], 0, lt[2]);
    this.light.position.set(lt[0] + 6, 14, lt[2] - 8);
  }

  /** Draw the root's path on the floor. */
  setTrail(points: [number, number, number][]) {
    const arr = new Float32Array(points.length * 3);
    points.forEach((p, i) => arr.set([p[0], 0.02, p[2]], i * 3));
    this.trail.geometry.dispose();
    this.trail.geometry = new THREE.BufferGeometry();
    this.trail.geometry.setAttribute("position", new THREE.BufferAttribute(arr, 3));
  }

  resetCamera() {
    this.camera.fov = 40;
    this.camera.updateProjectionMatrix();
    this.controls.target.set(this.lastRoot.x, 3, this.lastRoot.z);
    this.camera.position.set(this.lastRoot.x + 8, 6.5, this.lastRoot.z - 15);
  }

  /** Look at the rig from the direction the source camera was looking. */
  viewFrom(dir: [number, number, number], fovDeg: number) {
    this.camera.fov = Math.min(60, Math.max(25, fovDeg * 0.75));
    this.camera.updateProjectionMatrix();
    const t = this.controls.target;
    const dist = 16;
    this.camera.position.set(t.x - dir[0] * dist, t.y - dir[1] * dist, t.z - dir[2] * dist);
  }

  private resize() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
