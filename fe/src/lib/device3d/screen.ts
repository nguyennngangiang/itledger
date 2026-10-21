// Canvas-drawn textures: what's on the device's screen, logos, labels.
// Drawn once per open; the screen shows THIS device's name and specs, so the
// model reads as "that laptop", not a stock render.
import * as THREE from "three";
import type { DeviceLike, Os } from "./kind";

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!] as const;
}

function texture(c: HTMLCanvasElement, anisotropy = 4) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = anisotropy;
  return t;
}

function rr(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

function fit(g: CanvasRenderingContext2D, text: string, max: number) {
  if (g.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && g.measureText(t + "…").width > max) t = t.slice(0, -1);
  return t + "…";
}

/** Screen contents, `aspect` = width / height of the visible glass. */
export function screenTexture(d: DeviceLike, os: Os, aspect: number, on: boolean): THREE.Texture {
  const W = 1024, H = Math.round(W / aspect);
  const [c, g] = canvas(W, H);
  if (!on) {
    // switched off: near-black glass; reflections come from the material
    g.fillStyle = "#07080a";
    g.fillRect(0, 0, W, H);
    return texture(c);
  }
  // wallpaper
  if (os === "mac") {
    const bg = g.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, "#1d2b64"); bg.addColorStop(0.55, "#7b4397"); bg.addColorStop(1, "#f8b26a");
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
  } else if (os === "android" || os === "ios") {
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#0f2027"); bg.addColorStop(0.5, "#203a43"); bg.addColorStop(1, "#2c5364");
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
  } else {
    // Windows 11-ish bloom
    g.fillStyle = "#0a1a3a"; g.fillRect(0, 0, W, H);
    for (const [x, y, r, col] of [[0.55, 0.62, 0.62, "rgba(48,128,255,.95)"], [0.42, 0.55, 0.42, "rgba(120,190,255,.8)"],
      [0.6, 0.5, 0.26, "rgba(230,245,255,.75)"]] as const) {
      const gr = g.createRadialGradient(W * x, H * y, 0, W * x, H * y, W * r);
      gr.addColorStop(0, col); gr.addColorStop(1, "rgba(10,26,58,0)");
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
    }
  }
  // chrome
  if (os === "mac") {
    g.fillStyle = "rgba(255,255,255,.28)"; g.fillRect(0, 0, W, H * 0.035);
    rr(g, W * 0.3, H * 0.9, W * 0.4, H * 0.07, H * 0.02);
    g.fillStyle = "rgba(255,255,255,.3)"; g.fill();
    for (let i = 0; i < 9; i++) {
      rr(g, W * 0.315 + i * W * 0.042, H * 0.91, W * 0.034, W * 0.034, W * 0.008);
      g.fillStyle = `hsl(${i * 40},70%,60%)`; g.fill();
    }
  } else if (os === "windows" || os === "none") {
    g.fillStyle = "rgba(20,24,34,.72)"; g.fillRect(0, H * 0.93, W, H * 0.07);
    for (let i = 0; i < 7; i++) {
      rr(g, W * 0.39 + i * W * 0.033, H * 0.943, W * 0.022, W * 0.022, W * 0.005);
      g.fillStyle = i === 0 ? "#4aa3ff" : ["#f5c542", "#3ddc84", "#ff6b6b", "#b48cff", "#5ad1e6", "#ffffff"][i - 1];
      g.fill();
    }
  }
  // info card
  const cw = W * 0.56, ch = H * 0.36, cx = (W - cw) / 2, cy = H * 0.26;
  rr(g, cx, cy, cw, ch, W * 0.02);
  g.fillStyle = "rgba(255,255,255,.16)"; g.fill();
  g.strokeStyle = "rgba(255,255,255,.35)"; g.lineWidth = 2; g.stroke();
  g.fillStyle = "#fff"; g.textAlign = "center"; g.textBaseline = "middle";
  g.font = `600 ${Math.round(W * 0.042)}px ${FONT}`;
  g.fillText(fit(g, d.name?.trim() || "—", cw * 0.9), W / 2, cy + ch * 0.32);
  g.font = `400 ${Math.round(W * 0.026)}px ${FONT}`;
  g.fillStyle = "rgba(255,255,255,.85)";
  const spec = [d.cpu, d.ram, d.storage]
    .filter((x) => x && String(x).trim()).join(" · ");
  g.fillText(fit(g, spec || (d.os ?? ""), cw * 0.9), W / 2, cy + ch * 0.62);
  if (d.os) {
    g.font = `400 ${Math.round(W * 0.02)}px ${FONT}`;
    g.fillStyle = "rgba(255,255,255,.6)";
    g.fillText(fit(g, d.os, cw * 0.9), W / 2, cy + ch * 0.84);
  }
  return texture(c);
}

/** Logo / wordmark on a transparent background (for a decal plane). */
export function logoTexture(text: string, color: string, weight = 700, italic = false): THREE.Texture {
  const [c, g] = canvas(512, 128);
  g.fillStyle = color;
  g.textAlign = "center"; g.textBaseline = "middle";
  g.font = `${italic ? "italic " : ""}${weight} 84px ${FONT}`;
  g.fillText(fit(g, text, 500), 256, 66);
  return texture(c, 8);
}

/** Printed label (SSD sticker, etc.). */
export function labelTexture(lines: string[], bg: string, fg: string): THREE.Texture {
  const [c, g] = canvas(512, 384);
  g.fillStyle = bg; g.fillRect(0, 0, 512, 384);
  g.fillStyle = fg; g.textAlign = "left"; g.textBaseline = "top";
  lines.forEach((l, i) => {
    g.font = `${i === 0 ? 700 : 400} ${i === 0 ? 54 : 30}px ${FONT}`;
    g.fillText(fit(g, l, 440), 36, 40 + (i === 0 ? 0 : 50 + i * 42));
  });
  return texture(c, 8);
}

/** Soft contact shadow under the model — far cheaper than shadow maps. */
export function shadowTexture(): THREE.Texture {
  const [c, g] = canvas(256, 256);
  const gr = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  gr.addColorStop(0, "rgba(20,16,40,.55)");
  gr.addColorStop(0.55, "rgba(20,16,40,.2)");
  gr.addColorStop(1, "rgba(20,16,40,0)");
  g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
  return texture(c, 1);
}

/** Round badge logo (HP's chrome "hp", Dell's circled "DELL"). */
export function roundLogoTexture(text: string, color: string, ring: boolean): THREE.Texture {
  const [c, g] = canvas(256, 256);
  g.strokeStyle = color; g.fillStyle = color;
  g.lineWidth = 12;
  g.beginPath(); g.arc(128, 128, 112, 0, Math.PI * 2);
  if (ring) g.stroke(); else g.fill();
  g.fillStyle = ring ? color : "rgba(0,0,0,.55)";
  g.textAlign = "center"; g.textBaseline = "middle";
  g.font = `${ring ? 700 : "italic 700"} ${ring ? 64 : 120}px ${FONT}`;
  g.fillText(text, 128, ring ? 132 : 124);
  return texture(c, 8);
}

/** Front-panel grille: rows of holes (OptiPlex) or vertical slits (HP Pro Tower). */
export function grilleTexture(kind: "holes" | "slits", base: string, hole: string): THREE.Texture {
  const [c, g] = canvas(256, 512);
  g.fillStyle = base; g.fillRect(0, 0, 256, 512);
  g.fillStyle = hole;
  if (kind === "holes") {
    for (let y = 10; y < 512; y += 14) for (let x = 10 + ((y / 14) % 2) * 7; x < 256; x += 14) {
      g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.fill();
    }
  } else {
    for (let x = 14; x < 256; x += 18) g.fillRect(x, 16, 6, 480);
  }
  return texture(c, 4);
}

/** Rainbow side-light strip (DareU EK75). */
export function rainbowTexture(): THREE.Texture {
  const [c, g] = canvas(512, 8);
  const gr = g.createLinearGradient(0, 0, 512, 0);
  ["#ff3b5c", "#ffb02e", "#f5f53b", "#38e07b", "#2ec5ff", "#6b63ff", "#ff3bd4"].forEach((col, i, a) => gr.addColorStop(i / (a.length - 1), col));
  g.fillStyle = gr; g.fillRect(0, 0, 512, 8);
  return texture(c, 1);
}

/** Two-line printer LCD. */
export function lcdTexture(lines: string[]): THREE.Texture {
  const [c, g] = canvas(256, 96);
  g.fillStyle = "#9fd3ff"; g.fillRect(0, 0, 256, 96);
  g.fillStyle = "#0b2a44"; g.font = `600 30px ${FONT}`; g.textBaseline = "top";
  lines.slice(0, 2).forEach((l, i) => g.fillText(fit(g, l, 236), 10, 10 + i * 42));
  return texture(c, 2);
}
