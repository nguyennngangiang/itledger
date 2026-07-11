import { useEffect, useRef } from "react";
import * as THREE from "three";

// Pastel sparkle palette (matches the app's periwinkle / mint / pink / sky / amber).
const PALETTE = [
  [0.647, 0.706, 0.988], // periwinkle  #a5b4fc
  [0.576, 0.773, 0.992], // sky         #93c5fd
  [0.431, 0.906, 0.718], // mint        #6ee7b7
  [0.988, 0.827, 0.302], // amber       #fcd34d
  [0.976, 0.659, 0.831], // pink        #f9a8d4
  [0.769, 0.710, 0.988], // lilac       #c4b5fd
];

/** A soft glowing 4-point star sprite, drawn once to a canvas texture. */
function makeStarTexture(): THREE.Texture {
  const size = 128;
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const ctx = cv.getContext("2d")!;
  const c = size / 2;

  // soft round glow
  const glow = ctx.createRadialGradient(c, c, 0, c, c, c);
  glow.addColorStop(0, "rgba(255,255,255,1)");
  glow.addColorStop(0.25, "rgba(255,255,255,0.85)");
  glow.addColorStop(0.5, "rgba(255,255,255,0.25)");
  glow.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);

  // sparkle cross flares
  ctx.globalCompositeOperation = "lighter";
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineCap = "round";
  for (const [dx, dy, w] of [
    [1, 0, 2],
    [0, 1, 2],
  ] as const) {
    const grad = ctx.createLinearGradient(c - dx * c, c - dy * c, c + dx * c, c + dy * c);
    grad.addColorStop(0, "rgba(255,255,255,0)");
    grad.addColorStop(0.5, "rgba(255,255,255,0.9)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.strokeStyle = grad;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(c - dx * c, c - dy * c);
    ctx.lineTo(c + dx * c, c + dy * c);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.needsUpdate = true;
  return tex;
}

export function SparkleBackground() {
  const mountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.1,
      100,
    );
    camera.position.z = 26;

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);

    // --- build the particle field ---
    const COUNT = 900;
    const positions = new Float32Array(COUNT * 3);
    const colors = new Float32Array(COUNT * 3);
    const scales = new Float32Array(COUNT);
    const phases = new Float32Array(COUNT);
    const speeds = new Float32Array(COUNT);

    for (let i = 0; i < COUNT; i++) {
      positions[i * 3 + 0] = (Math.random() - 0.5) * 60;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 40;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 40;
      const col = PALETTE[(Math.random() * PALETTE.length) | 0];
      colors[i * 3 + 0] = col[0];
      colors[i * 3 + 1] = col[1];
      colors[i * 3 + 2] = col[2];
      scales[i] = 8 + Math.random() * 26;
      phases[i] = Math.random() * Math.PI * 2;
      speeds[i] = 1.5 + Math.random() * 3.5;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
    geo.setAttribute("aScale", new THREE.BufferAttribute(scales, 1));
    geo.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));
    geo.setAttribute("aSpeed", new THREE.BufferAttribute(speeds, 1));

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
        uTexture: { value: makeStarTexture() },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aScale;
        attribute float aPhase;
        attribute float aSpeed;
        uniform float uTime;
        uniform float uPixelRatio;
        varying vec3 vColor;
        varying float vTwinkle;
        void main() {
          vColor = aColor;
          // per-particle twinkle 0..1
          vTwinkle = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(uTime * aSpeed + aPhase), 2.0);
          vec3 pos = position;
          // gentle floating drift
          pos.y += sin(uTime * 0.4 + aPhase) * 1.2;
          pos.x += cos(uTime * 0.3 + aPhase) * 1.0;
          vec4 mv = modelViewMatrix * vec4(pos, 1.0);
          gl_PointSize = aScale * uPixelRatio * vTwinkle * (24.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uTexture;
        varying vec3 vColor;
        varying float vTwinkle;
        void main() {
          vec4 tex = texture2D(uTexture, gl_PointCoord);
          gl_FragColor = vec4(vColor, 1.0) * tex * vTwinkle;
        }
      `,
    });

    const points = new THREE.Points(geo, material);
    scene.add(points);

    // --- interaction: subtle parallax toward the pointer ---
    const target = { x: 0, y: 0 };
    const onPointer = (e: PointerEvent) => {
      target.x = (e.clientX / window.innerWidth - 0.5) * 2;
      target.y = (e.clientY / window.innerHeight - 0.5) * 2;
    };
    window.addEventListener("pointermove", onPointer);

    const onResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener("resize", onResize);

    const start = performance.now();
    let raf = 0;
    const tick = () => {
      const t = (performance.now() - start) / 1000;
      material.uniforms.uTime.value = t;
      points.rotation.y += 0.0008;
      points.rotation.x += 0.0003;
      // ease camera toward pointer for depth parallax
      camera.position.x += (target.x * 3 - camera.position.x) * 0.03;
      camera.position.y += (-target.y * 2 - camera.position.y) * 0.03;
      camera.lookAt(scene.position);
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("resize", onResize);
      geo.dispose();
      material.uniforms.uTexture.value.dispose();
      material.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, []);

  return <div ref={mountRef} className="sparkle-bg" aria-hidden />;
}
