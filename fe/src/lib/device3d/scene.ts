// The 3D peek in the device row's info popover. Loaded with import() only when
// a popover opens (Device3D.tsx), and torn down completely when it closes —
// renderer, GPU context, geometries, textures. The team already flagged the
// sparkle field for slowing their machines; this must cost nothing while closed.
//
// Frames are drawn on demand: while auto-turning, while damping settles after
// a drag, or while the lid animates — otherwise the loop stops. Hidden tab, or
// a weak / reduced-motion machine: no auto-turn, a frame only when dragged.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { DeviceLike } from "./kind";
import { build, LID_CLOSED, LID_OPEN } from "./models";
import { shadowTexture } from "./screen";

export type Peek = {
  /** laptop only: fold the lid open/closed; false when the model has no lid */
  toggleLid(): boolean;
  hasLid: boolean;
  dispose(): void;
};

export function mount(canvas: HTMLCanvasElement, device: DeviceLike, opts: { still: boolean; onLost: () => void }): Peek {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const env = pmrem.fromScene(room, 0.04).texture;
  scene.environment = env;
  room.dispose();
  pmrem.dispose();

  // one warm key light from upper left for a highlight the env alone lacks
  const key = new THREE.DirectionalLight("#fff4e6", 1.2);
  key.position.set(-4, 7, 5);
  scene.add(key);
  scene.add(new THREE.HemisphereLight("#e9e6ff", "#2a2638", 0.35));

  const { group, lid } = build(device);
  scene.add(group);

  // frame the model: bounding sphere → camera distance for the fov
  const bbox = new THREE.Box3().setFromObject(group);
  const sphere = bbox.getBoundingSphere(new THREE.Sphere());
  const centre = sphere.center.clone();
  const r = Math.max(sphere.radius, 0.5);

  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = bbox.min.y + 0.002;
  shadow.scale.set((bbox.max.x - bbox.min.x) * 1.5 + 0.6, (bbox.max.z - bbox.min.z) * 1.5 + 0.6, 1);
  scene.add(shadow);

  const camera = new THREE.PerspectiveCamera(30, 1, r / 20, r * 30);
  const dist = r / Math.sin(THREE.MathUtils.degToRad(30) / 2) * 1.02;
  // three-quarter view from the front-right, a little above
  camera.position.copy(centre).add(new THREE.Vector3(Math.sin(0.6) * 0.92, 0.38, Math.cos(0.6) * 0.92).normalize().multiplyScalar(dist));

  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(centre);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = dist * 0.55;
  controls.maxDistance = dist * 1.8;
  controls.minPolarAngle = 0.12 * Math.PI;
  controls.maxPolarAngle = 0.56 * Math.PI;      // a peek under the desk edge, not below the floor
  controls.autoRotate = !opts.still;
  controls.autoRotateSpeed = 1.4;
  controls.update();

  const size = () => {
    const w = canvas.clientWidth || 300, h = canvas.clientHeight || 220;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  size();

  // ── on-demand loop ──
  let raf = 0, alive = true, settling = 0;
  let lidAnim: { from: number; to: number; t0: number } | null = null;

  const frame = (now: number) => {
    raf = 0;
    if (!alive || document.hidden) return;
    let more = controls.autoRotate;
    if (lidAnim && lid) {
      const k = Math.min(1, (now - lidAnim.t0) / 650);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      lid.rotation.x = lidAnim.from + (lidAnim.to - lidAnim.from) * e;
      if (k >= 1) lidAnim = null; else more = true;
    }
    if (controls.update()) settling = 12;          // still easing after a drag
    if (settling > 0) { settling--; more = true; }
    renderer.render(scene, camera);
    if (more) request();
  };
  const request = () => { if (!raf && alive) raf = requestAnimationFrame(frame); };

  // a drag (or wheel) stops the turntable for good and keeps frames coming
  const onStart = () => { controls.autoRotate = false; canvas.classList.add("grabbing"); };
  const onEnd = () => canvas.classList.remove("grabbing");
  controls.addEventListener("start", onStart);
  controls.addEventListener("end", onEnd);
  controls.addEventListener("change", request);
  const onVis = () => { if (!document.hidden) request(); };
  document.addEventListener("visibilitychange", onVis);
  const ro = new ResizeObserver(() => { size(); request(); });
  ro.observe(canvas);
  const onLost = (e: Event) => { e.preventDefault(); alive = false; opts.onLost(); };
  canvas.addEventListener("webglcontextlost", onLost);

  request();

  return {
    hasLid: !!lid,
    toggleLid() {
      if (!lid) return false;
      // mid-animation: reverse it; at rest: go to the other end
      const goingOpen = lidAnim ? lidAnim.to === LID_OPEN : Math.abs(lid.rotation.x - LID_OPEN) < 0.2;
      const to = goingOpen ? LID_CLOSED : LID_OPEN;
      lidAnim = { from: lid.rotation.x, to, t0: performance.now() };
      request();
      return true;
    },
    dispose() {
      alive = false;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      canvas.removeEventListener("webglcontextlost", onLost);
      controls.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
        for (const mat of mats) {
          for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
          mat.dispose();
        }
      });
      env.dispose();
      renderer.dispose();
      // Give the GPU context back now; browsers cap live contexts (~16) and
      // hovering down a 300-row table would otherwise hit the cap.
      renderer.forceContextLoss();
    },
  };
}
