// Procedural device models. 1 unit = 10 cm, and where the row names a real
// product (variantOf in kind.ts) the model follows that product's published
// design: dimensions, colour, numpad or not, logo shape and place, stand,
// ports. Sources are the makers' spec pages (HP 15-fd, Vivobook 15 X1502VA,
// Inspiron 16 5640, LG 24U411A-B, Samsung S27C310, LaserJet Pro 4003dn,
// Logitech B100, DareU EK75, UGREEN CM512, iPad 11" A16, POCO Pad C1, Mac mini
// M1, HP Pro Tower 400 G9, OptiPlex 7010 Tower, MacBook Air M1).
// Everything else gets a believable generic of its kind, finished per brand.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import {
  finishOf, inchesOf, kindOf, ledOf, monitorsInSet, namedColour, osOf, setTower, variantOf,
  type DeviceLike, type Finish, type Kind, type Variant,
} from "./kind";
import {
  grilleTexture, labelTexture, lcdTexture, logoTexture, rainbowTexture, roundLogoTexture, screenTexture,
} from "./screen";

export type Built = {
  group: THREE.Group;
  kind: Kind;
  /** laptop only: the lid pivot, rotation.x = LID_OPEN … LID_CLOSED */
  lid?: THREE.Object3D;
};

export const LID_OPEN = -0.33;          // ~109° from the deck
export const LID_CLOSED = Math.PI / 2;

const box = (w: number, h: number, d: number, r = 0.04, seg = 4) =>
  new RoundedBoxGeometry(w, h, d, seg, Math.max(1e-3, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3)));

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  return m;
}

// ── materials ────────────────────────────────────────────────────────────────

/** Anodised aluminium (metal) or matte/textured plastic. */
function shell(color: string, metal: boolean, roughness?: number) {
  return new THREE.MeshPhysicalMaterial({
    color,
    metalness: metal ? 0.85 : 0.05,
    roughness: roughness ?? (metal ? 0.36 : 0.55),
    clearcoat: metal ? 0.2 : 0.08,
    clearcoatRoughness: 0.45,
  });
}
const bodyMat = (f: Finish) => shell(f.body, f.metal);
const plastic = (color: string, roughness = 0.6) =>
  new THREE.MeshPhysicalMaterial({ color, metalness: 0, roughness, clearcoat: 0.05 });
const rubber = (color = "#141518") => new THREE.MeshStandardMaterial({ color, roughness: 0.92, metalness: 0 });
const metal = (color = "#c8ccd2", roughness = 0.28) =>
  new THREE.MeshStandardMaterial({ color, metalness: 1, roughness });

function glassMat(tex: THREE.Texture, on: boolean) {
  return new THREE.MeshPhysicalMaterial({
    color: "#020203",
    emissive: on ? "#ffffff" : "#000000",
    emissiveMap: tex,
    emissiveIntensity: on ? 1.05 : 0,
    map: on ? null : tex,
    roughness: 0.06,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
  });
}

function ledMat(color: string | null, strength = 2.4) {
  return new THREE.MeshStandardMaterial({
    color: color ?? "#22252a",
    emissive: color ?? "#000000",
    emissiveIntensity: color ? strength : 0,
    roughness: 0.3,
  });
}

/** Flat decal (logo/label) facing +z; caller rotates/positions it. */
function decal(tex: THREE.Texture, w: number, h: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.3, metalness: 0.4, ...opts }),
  );
  m.renderOrder = 1;
  return m;
}

function screen(d: DeviceLike, w: number, h: number, on: boolean) {
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), glassMat(screenTexture(d, osOf(d), w / h, on), on));
}

/** Small rubber feet under a slab. */
function feet(g: THREE.Group, xs: number[], zs: number[], r = 0.06) {
  for (const x of xs) for (const z of zs) g.add(mesh(new THREE.CylinderGeometry(r, r, 0.03, 16), rubber(), x, 0.015, z));
}

// ── laptops ──────────────────────────────────────────────────────────────────

type LaptopSpec = {
  W: number; D: number; T: number;     // footprint and base thickness
  aspect: number;                      // screen w/h (16:9 or 16:10)
  body: string; metal: boolean;
  keys: string; deck: string; numpad: boolean;
  logo: "hp" | "dell" | "corner" | "center" | "none"; logoText: string; logoColor: string;
  chin: number;                        // bezel below the screen
  chinText: string;
  wedge: boolean;                      // MacBook Air: thin at the front
  enterAccent?: string;                // Vivobook's yellow Enter
};

function laptopSpec(d: DeviceLike, f: Finish, v: Variant): LaptopSpec {
  switch (v) {
    case "hp15":          // 359.8 × 236 × 18.6 mm, Natural Silver, light keys, numpad, round chrome logo
      return { W: 3.6, D: 2.36, T: 0.15, aspect: 16 / 9, body: "#c7c8ca", metal: false, keys: "#d9dadc", deck: "#a9abae",
        numpad: true, logo: "hp", logoText: "hp", logoColor: "#eceef1", chin: 0.2, chinText: "hp", wedge: false };
    case "vivobook":      // 359.7 × 232.5 × 19.9 mm, Icelight Silver / Quiet Blue, numpad, logo top-left
      return { W: 3.6, D: 2.33, T: 0.16, aspect: 16 / 9, body: namedColour(d, { blue: "#2e3a4f" }) ?? "#c9cdd2", metal: false,
        keys: "#2d3138", deck: "#a7abb1", numpad: true, logo: "corner", logoText: "VIVOBOOK", logoColor: "#e3e6ea",
        chin: 0.22, chinText: "ASUS Vivobook", wedge: false, enterAccent: "#f2c230" };
    case "inspiron":      // 356.8 × 249.5 × 19 mm, 16:10, aluminium lid, numpad, round DELL logo
      return { W: 3.57, D: 2.5, T: 0.15, aspect: 16 / 10, body: namedColour(d, { blue: "#b9c7d3" }) ?? "#cfd1d3", metal: true,
        keys: "#1c1d20", deck: "#0d0e10", numpad: true, logo: "dell", logoText: "DELL", logoColor: "#f2f3f5",
        chin: 0.06, chinText: "", wedge: false };
    case "macbook":       // 304.1 × 212.4 × 4.1–16.1 mm wedge, silver, no numpad
      return { W: 3.04, D: 2.12, T: 0.16, aspect: 16 / 10, body: "#e3e4e5", metal: true, keys: "#121214", deck: "#0d0e10",
        numpad: false, logo: "none", logoText: "", logoColor: "", chin: 0.14, chinText: "MacBook Air", wedge: true };
    default:              // a 15.6" office laptop of that brand
      return { W: 3.6, D: 2.4, T: 0.18, aspect: 16 / 9, body: f.body, metal: f.metal, keys: "#141517", deck: "#0d0e10",
        numpad: true, logo: f.logo ? "center" : "none", logoText: f.logo, logoColor: f.accent, chin: 0.16,
        chinText: "", wedge: false };
  }
}

/** MacBook-style wedge: squeeze the top of the base toward the front edge. */
function wedge(geo: THREE.BufferGeometry, D: number, front: number, back: number) {
  const p = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y <= 0) continue;
    const k = p.getZ(i) / D + 0.5;                 // 0 back … 1 front
    p.setY(i, y * ((back + (front - back) * k) / back));
  }
  p.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

function laptop(d: DeviceLike, f: Finish, on: boolean, v: Variant): Built {
  const s = laptopSpec(d, f, v);
  const g = new THREE.Group();
  const body = shell(s.body, s.metal);
  const { W, D, T } = s;
  const FRONT = 0.045;
  g.add(mesh(s.wedge ? wedge(box(W, T, D, 0.06), D, FRONT, T) : box(W, T, D, 0.06), body, 0, T / 2, 0));
  feet(g, [-W / 2 + 0.3, W / 2 - 0.3], [-D / 2 + 0.25, D / 2 - 0.25], 0.05);
  // deck height at depth z (the base is centred at y = T/2, so the wedge top is T/2 + scaled half)
  const deckY = (z: number) => (s.wedge ? T / 2 + (T / 2) * ((T + (FRONT - T) * (z / D + 0.5)) / T) : T);

  // keyboard: main block of 14 columns, plus a 4-column numpad where the real one has it
  const cols = 14 + (s.numpad ? 4.3 : 0);
  const pitch = (W - 0.42) / cols;
  const K = pitch * 0.84;
  const ROWS = 6;
  const deckZ = -D / 2 + 0.33 + (ROWS * pitch) / 2;
  const left = -W / 2 + 0.21 + pitch / 2;
  g.add(mesh(new THREE.BoxGeometry(W - 0.3, 0.004, ROWS * pitch + 0.1), plastic(s.deck, 0.85), 0, deckY(deckZ) + 0.001, deckZ));
  const keyMat = plastic(s.keys, 0.5);
  const keys = new THREE.InstancedMesh(box(K, 0.028, K, 0.018, 2), keyMat, ROWS * Math.ceil(cols));
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
  let n = 0;
  const keyAt = (x: number, z: number, sz = 1) => {
    m4.compose(new THREE.Vector3(x, deckY(z) + 0.016, z), q, new THREE.Vector3(1, 1, sz));
    keys.setMatrixAt(n++, m4);
  };
  const z0 = deckZ - ((ROWS - 1) * pitch) / 2;
  for (let r = 0; r < ROWS; r++) {
    const z = z0 + r * pitch - (r === 0 ? pitch * 0.15 : 0);
    for (let c = 0; c < 14; c++) {
      if (r === ROWS - 1 && c >= 4 && c <= 9) continue;           // spacebar below
      if (s.enterAccent && r === 3 && c === 13) continue;          // accent Enter below
      keyAt(left + c * pitch, z, r === 0 ? 0.55 : 1);
    }
    if (s.numpad && r > 0) for (let c = 0; c < 4; c++) keyAt(left + (14.3 + c) * pitch, z);
  }
  keys.count = n;
  g.add(keys);
  const zSpace = z0 + (ROWS - 1) * pitch;
  g.add(mesh(box(6 * pitch - (pitch - K), 0.028, K, 0.018, 2), keyMat, left + 6.5 * pitch, deckY(zSpace) + 0.016, zSpace));
  if (s.enterAccent) {
    const ze = z0 + 3 * pitch;
    g.add(mesh(box(K, 0.03, K, 0.018, 2), plastic(s.enterAccent, 0.45), left + 13 * pitch, deckY(ze) + 0.017, ze));
  }
  // touchpad: centred under the MAIN block, as on numpad laptops
  const padW = s.numpad ? 1.1 : 1.35, padD = s.wedge ? 0.78 : 0.7;
  const padX = s.numpad ? left + 6.5 * pitch : 0, padZ = deckZ + (ROWS * pitch) / 2 + 0.12 + padD / 2;
  g.add(mesh(box(padW, 0.006, padD, 0.003, 2),
    new THREE.MeshPhysicalMaterial({ color: s.body, metalness: s.metal ? 0.6 : 0.05, roughness: 0.2, clearcoat: 0.8 }),
    padX, deckY(padZ) + 0.001, padZ));
  g.add(mesh(new THREE.SphereGeometry(0.016, 12, 8), ledMat(ledOf(d.status)), W / 2 - 0.25, deckY(D / 2) * 0.55, D / 2 + 0.002));

  // lid on a hinge at the back edge; the pivot sits half a lid plus a keycap
  // above the deck, so the closed lid rests ON the keys instead of through them
  const lid = new THREE.Group();
  const LT = s.wedge ? 0.045 : 0.07;
  const scrW = W - 0.12, scrH = scrW / s.aspect;
  const LH = scrH + s.chin + 0.08;
  lid.position.set(0, T + LT / 2 + 0.032, -D / 2 + 0.05);
  lid.add(mesh(box(W, LH, LT, 0.05), body, 0, LH / 2, 0));
  lid.add(mesh(new THREE.PlaneGeometry(W - 0.04, LH - 0.04), plastic("#050506", 0.25), 0, LH / 2, LT / 2 + 0.001));
  const scr = screen(d, scrW - 0.06, scrH - 0.04, on);
  scr.position.set(0, s.chin + scrH / 2, LT / 2 + 0.002);
  lid.add(scr);
  if (s.logo === "hp" || s.logo === "dell") {
    const size = s.logo === "hp" ? 0.27 : 0.32;
    const logo = decal(roundLogoTexture(s.logoText, s.logoColor, s.logo === "dell"), size, size, { metalness: 1, roughness: 0.1 });
    logo.rotation.y = Math.PI;
    logo.position.set(0, LH / 2, -LT / 2 - 0.002);
    lid.add(logo);
  } else if (s.logo === "corner" || s.logo === "center") {
    const corner = s.logo === "corner";
    const logo = decal(logoTexture(s.logoText, s.logoColor, 700), corner ? 0.7 : 0.9, corner ? 0.175 : 0.225,
      { metalness: 0.8, roughness: 0.25 });
    logo.rotation.y = Math.PI;
    // seen from behind, the maker's top-left is the viewer's top-right
    logo.position.set(corner ? W / 2 - 0.55 : 0, corner ? LH - 0.3 : LH / 2, -LT / 2 - 0.002);
    lid.add(logo);
  }
  if (s.chinText) {
    const t = decal(logoTexture(s.chinText, "#9a9ca3", 600), 0.5, 0.125, { metalness: 0.1 });
    t.position.set(0, s.chin / 2 + 0.02, LT / 2 + 0.003);
    lid.add(t);
  }
  const hinge = mesh(new THREE.CylinderGeometry(0.07, 0.07, W * 0.8, 20), plastic(s.metal ? s.body : "#1d1e21", 0.4), 0, -0.02, 0);
  hinge.rotation.z = Math.PI / 2;
  lid.add(hinge);
  lid.rotation.x = LID_OPEN;
  g.add(lid);
  return { group: g, kind: "laptop", lid };
}

// ── monitors ─────────────────────────────────────────────────────────────────

/** 16:9 office monitor. LG: 3-side borderless, thin neck, oval plate base,
 *  joystick under the logo. Samsung: V-shaped neck, wide flat base. */
function monitorGroup(d: DeviceLike, inch: number, v: Variant, on: boolean): THREE.Group {
  const g = new THREE.Group();
  const W = inch * 0.2214, H = (W * 9) / 16;
  const black = shell(v === "samsung" ? "#1c1c1e" : "#141416", false, 0.5);
  const side = 0.035, chin = v === "monitor" ? 0.16 : 0.12;
  const y0 = (inch >= 27 ? 1.0 : 0.9) + chin + H / 2;
  g.add(mesh(box(W + side * 2, H + side + chin, 0.1, 0.03), black, 0, y0 - (chin - side) / 2, 0));
  g.add(mesh(box(W * 0.62, H * 0.6, 0.3, 0.12), black, 0, y0 - H * 0.05, -0.17));
  const s = screen(d, W, H, on);
  s.position.set(0, y0, 0.051);
  g.add(s);
  const logoTxt = v === "lg" ? "LG" : v === "samsung" ? "SAMSUNG" : finishOf(d).logo || "";
  if (logoTxt) {
    const wide = logoTxt.length > 3;
    const logo = decal(logoTexture(logoTxt, "#c9ccd2", 700), wide ? 0.6 : 0.3, wide ? 0.15 : 0.075, { metalness: 0.3 });
    logo.position.set(0, y0 - H / 2 - chin / 2, 0.052);
    g.add(logo);
  }
  g.add(mesh(new THREE.SphereGeometry(0.012, 10, 8), ledMat(ledOf(d.status)), W / 2 - 0.15, y0 - H / 2 - chin / 2, 0.052));
  if (v === "lg") g.add(mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.05, 12), plastic("#222"), 0, y0 - H / 2 - chin - 0.02, 0));

  if (v === "samsung") {
    for (const sx of [-1, 1]) {
      const leg = mesh(box(0.1, y0 - 0.2, 0.08, 0.03), metal("#3a3c40", 0.35), sx * 0.22, (y0 - 0.2) / 2 + 0.05, -0.36);
      leg.rotation.z = sx * 0.16;
      g.add(leg);
    }
    g.add(mesh(box(2.9, 0.04, 2.17, 0.02), black, 0, 0.02, -0.25));
  } else {
    const neck = mesh(box(0.34, y0 - 0.1, 0.12, 0.05), black, 0, (y0 - 0.1) / 2 + 0.04, -0.36);
    neck.rotation.x = -0.08;
    g.add(neck);
    const base = mesh(new THREE.CylinderGeometry(1.15, 1.2, 0.04, 56), black, 0, 0.02, -0.3);
    base.scale.z = (v === "lg" ? 2.2 : 1.9) / 2.4;
    g.add(base);
  }
  return g;
}

// ── towers ───────────────────────────────────────────────────────────────────

function towerGroup(d: DeviceLike, v: Variant): THREE.Group {
  const g = new THREE.Group();
  // W × H × D from the spec pages (Pro Tower 400 G9, OptiPlex 7010 Tower, a
  // GIGABYTE C-series case); a generic mid tower otherwise
  const [W, H, D] = v === "hp-tower" ? [1.55, 3.37, 3.08] : v === "dell-tower" ? [1.54, 3.24, 2.92]
    : v === "gaming" ? [2.05, 4.5, 4.0] : [1.85, 4.1, 3.9];
  const black = shell(v === "dell-tower" ? "#16171a" : "#1a1a1c", false, 0.55);
  const y = H / 2 + 0.05;
  g.add(mesh(box(W, H, D, 0.05), black, 0, y, 0));
  feet(g, [-W / 2 + 0.2, W / 2 - 0.2], [-D / 2 + 0.3, D / 2 - 0.3], 0.07);
  const front = D / 2 + 0.012;
  const led = ledOf(d.status);
  const plate = (tex: THREE.Texture, w: number, h: number, yy: number, metalness = 0) =>
    mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, metalness }), 0, yy, front);

  if (v === "hp-tower") {
    g.add(plate(grilleTexture("slits", "#202124", "#0b0b0c"), W - 0.1, H - 0.5, y - 0.18));
    const logo = decal(roundLogoTexture("hp", "#d9dce1", false), 0.3, 0.3, { metalness: 1, roughness: 0.15 });
    logo.position.set(0, H - 0.75, front + 0.002);
    g.add(logo);
    // top-front I/O strip: power + USB-A + USB-C + audio
    g.add(mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.03, 24), ledMat(led, 1.2), -0.45, H + 0.06, D / 2 - 0.25));
    for (const x of [-0.15, 0.08, 0.31]) g.add(mesh(new THREE.BoxGeometry(0.17, 0.02, 0.06), plastic("#050505"), x, H + 0.055, D / 2 - 0.25));
  } else if (v === "dell-tower") {
    g.add(plate(grilleTexture("holes", "#1d1e21", "#050506"), W - 0.12, H - 0.9, y - 0.3, 0.3));
    const logo = decal(roundLogoTexture("DELL", "#c6cad0", true), 0.32, 0.32, { metalness: 0.9, roughness: 0.2 });
    logo.position.set(0, H - 0.45, front + 0.002);
    g.add(logo);
    g.add(mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.03, 24), ledMat(led, 1.2), 0.45, H - 0.25, front).rotateX(Math.PI / 2));
    g.add(mesh(new THREE.BoxGeometry(W * 0.6, 0.06, 0.6), plastic("#0a0a0b"), 0, H + 0.03, -D / 2 + 0.45));   // carry-handle recess
  } else if (v === "gaming") {
    // tempered-glass side panel, RGB fans glowing behind a mesh front
    const glass = new THREE.MeshPhysicalMaterial({ color: "#0d0f14", roughness: 0.04, opacity: 0.55, transparent: true, clearcoat: 1 });
    const pane = mesh(new THREE.PlaneGeometry(D - 0.25, H - 0.3), glass, -W / 2 - 0.006, y, 0);
    pane.rotation.y = -Math.PI / 2;
    g.add(pane);
    g.add(plate(grilleTexture("holes", "#141416", "#020203"), W - 0.2, H - 0.4, y));
    ["#ff3bd4", "#2ec5ff", "#6b63ff"].forEach((c, i) =>
      g.add(mesh(new THREE.TorusGeometry(0.55, 0.035, 10, 48), ledMat(c, 2.2), 0, H - 1.0 - i * 1.25, front - 0.04)));
    const inner = mesh(new THREE.TorusGeometry(0.5, 0.03, 10, 48), ledMat("#2ec5ff", 1.8), -W / 2 + 0.25, H - 1.2, -0.6);
    inner.rotation.y = Math.PI / 2;
    g.add(inner);
    const logo = decal(logoTexture("GIGABYTE", "#ff7a1a", 700), 0.9, 0.22, { metalness: 0.3 });
    logo.position.set(0, 0.4, front + 0.003);
    g.add(logo);
    g.add(mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.03, 24), ledMat(led, 1.2), 0.5, H + 0.06, D / 2 - 0.4));
  } else {
    g.add(plate(grilleTexture("holes", "#18191c", "#050506"), W - 0.14, H - 0.6, y - 0.2));
    g.add(mesh(new THREE.TorusGeometry(0.1, 0.012, 8, 40), ledMat(led), 0, H - 0.15, front + 0.004));
    const name = finishOf(d).logo;
    if (name) {
      const logo = decal(logoTexture(name, "#c9ccd2", 700), 0.8, 0.2, { metalness: 0.5 });
      logo.position.set(0, 0.45, front + 0.003);
      g.add(logo);
    }
  }
  return g;
}

function minipc(d: DeviceLike): Built {
  // Mac mini M1: 197 × 197 × 36 mm, silver, black foot ring, white LED front-right
  const g = new THREE.Group();
  g.add(mesh(box(1.97, 0.33, 1.97, 0.26, 6), shell("#d6d7d9", true, 0.3), 0, 0.195, 0));
  g.add(mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.03, 48), rubber("#151517"), 0, 0.015, 0));
  g.add(mesh(new THREE.SphereGeometry(0.011, 10, 8), ledMat(ledOf(d.status) ? "#ffffff" : null), 0.82, 0.16, 0.986));
  // rear ports, left to right: power, AC, Ethernet, 2× TB, HDMI, 2× USB-A, audio
  const port = plastic("#070707", 0.8);
  [[-0.75, 0.06, 0.06], [-0.55, 0.1, 0.08], [-0.33, 0.12, 0.1], [-0.12, 0.08, 0.035], [0.02, 0.08, 0.035],
    [0.2, 0.13, 0.05], [0.42, 0.11, 0.045], [0.6, 0.11, 0.045], [0.78, 0.04, 0.04]].forEach(([x, w, h]) =>
    g.add(mesh(new THREE.BoxGeometry(w, h, 0.02), port, x, 0.16, -0.986)));
  return { group: g, kind: "minipc" };
}

// ── slabs ────────────────────────────────────────────────────────────────────

function tablet(d: DeviceLike, f: Finish, on: boolean, v: Variant, kind: "tablet" | "phone"): Built {
  const g = new THREE.Group();
  let W: number, H: number, T: number, color: string, island: boolean, landscape: boolean;
  if (v === "ipad") {          // 179.5 × 248.6 × 7.0 mm, single round camera, no island
    [W, H, T, island, landscape] = [1.795, 2.486, 0.07, false, false];
    color = namedColour(d, { blue: "#a9c3da", silver: "#e3e4e5" }) ?? "#e3e4e5";
  } else if (v === "pocopad") { // 226.5 × 148 × 7.4 mm, held landscape, camera island
    [W, H, T, island, landscape] = [2.265, 1.48, 0.074, true, true];
    color = namedColour(d, { blue: "#7f9cc0" }) ?? "#6f7884";
  } else {
    const inch = inchesOf(d) ?? (kind === "tablet" ? 11 : 6.3);
    H = inch * 0.254 * (kind === "tablet" ? 0.82 : 0.9);
    W = H * (kind === "tablet" ? 0.72 : 0.47);
    T = kind === "tablet" ? 0.065 : 0.08;
    color = f.body; island = kind === "phone"; landscape = false;
  }
  const dev = new THREE.Group();
  dev.add(mesh(box(W, H, T, Math.min(W, H) * 0.07, 6), shell(color, true, 0.4)));
  dev.add(mesh(new THREE.PlaneGeometry(W - 0.03, H - 0.03), plastic("#040405", 0.2), 0, 0, T / 2 + 0.001));
  const bezel = v === "ipad" ? 0.1 : 0.09;
  const s = screen(d, W - bezel * 2, H - bezel * 2, on);
  s.position.z = T / 2 + 0.002;
  dev.add(s);
  // back camera: top-left as you look at the back (+x here, since the back faces -z)
  const cx = W / 2 - (landscape ? 0.22 : 0.16), cy = H / 2 - (landscape ? 0.22 : 0.16);
  if (island) dev.add(mesh(box(0.34, 0.34, 0.025, 0.08), plastic("#20232a", 0.3), cx, cy, -T / 2 - 0.012));
  const lens = mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.02, 24), plastic("#050505", 0.05), cx, cy, -T / 2 - (island ? 0.026 : 0.008));
  lens.rotation.x = Math.PI / 2;
  dev.add(lens);
  if (v === "pocopad") {
    const logo = decal(logoTexture("POCO", "#c8d4e6", 700), 0.45, 0.11, { metalness: 0.5 });
    logo.rotation.y = Math.PI;
    logo.position.set(0, -H / 2 + 0.3, -T / 2 - 0.002);
    dev.add(logo);
  }
  dev.rotation.x = -0.3;                 // on a desk stand, leaning back
  dev.position.set(0, (H / 2) * Math.cos(0.3) + 0.02, 0);
  g.add(dev);
  return { group: g, kind };
}

// ── peripherals ──────────────────────────────────────────────────────────────

function mouse(f: Finish, v: Variant): Built {
  // Logitech B100: 62 × 113 × 38 mm, symmetric low egg, matte black, cord out of the nose
  const g = new THREE.Group();
  const [W, L, H] = v === "b100" ? [0.62, 1.13, 0.38] : [0.64, 1.1, 0.4];
  const geo = new THREE.SphereGeometry(1, 56, 28, 0, Math.PI * 2, 0, Math.PI / 2);
  const p = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) * (1 + 0.18 * p.getZ(i)));   // hump toward the back
  geo.computeVertexNormals();
  const top = mesh(geo, v === "b100" ? shell("#1a1a1a", false, 0.6) : bodyMat(f));
  top.scale.set(W / 2, H * 0.85, L / 2);
  g.add(top);
  const sole = mesh(new THREE.CylinderGeometry(W / 2, W / 2, 0.02, 48), plastic("#0c0c0d"), 0, 0.01, 0);
  sole.scale.z = L / W;
  g.add(sole);
  g.add(mesh(new THREE.BoxGeometry(0.006, 0.06, L * 0.36), plastic("#050505"), 0, H * 0.72, -L * 0.3));   // button split
  const wheel = mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.05, 24), rubber("#2a2b2e"), 0, H * 0.74, -L * 0.25);
  wheel.rotation.z = Math.PI / 2;
  g.add(wheel);
  const cord = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.1, -L / 2 + 0.02), new THREE.Vector3(0, 0.06, -L / 2 - 0.4),
    new THREE.Vector3(0.25, 0.03, -L / 2 - 0.9), new THREE.Vector3(0.1, 0.03, -L / 2 - 1.5)]);
  g.add(new THREE.Mesh(new THREE.TubeGeometry(cord, 60, 0.02, 8), rubber("#121214")));
  const brand = v === "b100" ? "logitech" : f.logo;
  if (brand) {
    const logo = decal(logoTexture(brand, "#8c8f95", 600), 0.26, 0.065, { metalness: 0.1 });
    logo.rotation.x = -Math.PI / 2 + 0.55;
    logo.position.set(0, H * 0.7, L * 0.33);
    g.add(logo);
  }
  g.scale.setScalar(1.5);
  return { group: g, kind: "mouse" };
}

function keyboard(f: Finish, v: Variant): Built {
  const g = new THREE.Group();
  const ek75 = v === "ek75";
  // EK75: 75 % layout (81 keys), volume knob top-right, rainbow side light
  const COLS = ek75 ? 16 : 18, ROWS = 6, P = 0.19, K = P * 0.86;
  const W = COLS * P + 0.24, D = ROWS * P + 0.2;
  g.add(mesh(box(W, 0.26, D, 0.06), ek75 ? shell("#1b1b1b", false, 0.55) : bodyMat(f), 0, 0.13, 0));
  const keyMat = plastic("#1d1e21", 0.6), grey = plastic("#5a5d63", 0.6);
  const keys = new THREE.InstancedMesh(box(K, 0.1, K, 0.025, 2), keyMat, COLS * ROWS);
  const mods = new THREE.InstancedMesh(box(K, 0.1, K, 0.025, 2), grey, COLS * ROWS);
  const m4 = new THREE.Matrix4();
  let n = 0, nm = 0;
  const kx = (c: number) => -W / 2 + 0.12 + (c + 0.5) * P, kz = (r: number) => -D / 2 + 0.1 + (r + 0.5) * P;
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    if (r === 0 && c === 0) continue;                           // accent Esc below
    if (ek75 && r === 0 && c === COLS - 1) continue;            // the knob sits here
    if (ek75 && r === 2 && c >= COLS - 3 && c <= COLS - 2) continue;   // accent Enter below
    if (r === ROWS - 1 && c >= 4 && c <= 9) continue;           // spacebar
    m4.makeTranslation(kx(c), 0.31 + (ROWS - r) * 0.008, kz(r));
    if (c === 0 || c >= COLS - (ek75 ? 1 : 4) || r === 0) mods.setMatrixAt(nm++, m4); else keys.setMatrixAt(n++, m4);
  }
  keys.count = n; mods.count = nm;
  g.add(keys, mods);
  g.add(mesh(box(6 * P - (P - K), 0.1, K, 0.025, 2), keyMat, kx(6.5), 0.31, kz(ROWS - 1)));
  const accent = plastic(ek75 ? "#e8452c" : f.accent, 0.5);
  g.add(mesh(box(K, 0.101, K, 0.025, 2), accent, kx(0), 0.31 + ROWS * 0.008, kz(0)));
  if (ek75) {
    g.add(mesh(box(P * 2 - (P - K), 0.101, K, 0.025, 2), accent, kx(COLS - 2.5), 0.31 + 4 * 0.008, kz(2)));
    g.add(mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.16, 32), metal("#9aa0a8", 0.35), kx(COLS - 1), 0.37, kz(0)));
    const strip = new THREE.MeshBasicMaterial({ map: rainbowTexture() });
    for (const sx of [-1, 1]) {
      const s = mesh(new THREE.PlaneGeometry(D - 0.1, 0.06), strip, sx * (W / 2 + 0.002), 0.1, 0);
      s.rotation.y = (sx * Math.PI) / 2;
      g.add(s);
    }
    const logo = decal(logoTexture("DAREU", "#8c8f95", 700), 0.36, 0.09, { metalness: 0.2 });
    logo.position.set(-W / 2 + 0.4, 0.13, D / 2 + 0.002);
    g.add(logo);
  }
  g.rotation.x = 0.05;
  return { group: g, kind: "keyboard" };
}

function cable(d: DeviceLike): Built {
  const g = new THREE.Group();
  const path = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-1.6, 0.06, 0.6), new THREE.Vector3(-0.6, 0.06, 1.1), new THREE.Vector3(0.7, 0.06, 0.8),
    new THREE.Vector3(1.1, 0.06, -0.2), new THREE.Vector3(0.2, 0.06, -0.8), new THREE.Vector3(-0.9, 0.06, -0.4),
    new THREE.Vector3(-1.5, 0.06, -1.0),
  ]);
  g.add(new THREE.Mesh(new THREE.TubeGeometry(path, 160, 0.035, 12), rubber("#111214")));
  const name = d.name ?? "";
  const dp = /displayport/i.test(name);
  // HDMI 10109: black moulded shell (~22 × 12 × 40 mm) with grip ribs and a
  // gold-plated tip; "DisplayPort to HDMI" has one DP plug and one HDMI plug
  ([[0, -1, dp], [1, 1, false]] as const).forEach(([t, flip, isDp]) => {
    const p = path.getPointAt(t), tan = path.getTangentAt(t).multiplyScalar(flip);
    const plug = new THREE.Group();
    plug.add(mesh(box(0.22, 0.12, 0.4, 0.035), plastic("#141416", 0.5)));
    for (let i = 0; i < 4; i++) plug.add(mesh(new THREE.BoxGeometry(0.225, 0.125, 0.012), plastic("#0a0a0b"), 0, 0, -0.1 + i * 0.05));
    plug.add(mesh(box(isDp ? 0.17 : 0.14, isDp ? 0.06 : 0.045, 0.16, 0.01, 2), metal(isDp ? "#c8ccd2" : "#d9b45a", 0.25), 0, 0, 0.27));
    plug.add(mesh(new THREE.CylinderGeometry(0.05, 0.035, 0.12, 16), rubber(), 0, 0, -0.25).rotateX(Math.PI / 2));
    plug.position.copy(p).add(tan.clone().multiplyScalar(0.25));
    plug.lookAt(p.clone().add(tan));
    g.add(plug);
  });
  return { group: g, kind: "cable" };
}

function hub(): Built {
  // UGREEN CM512 7-in-1: ~110 × 33 × 17.5 mm space-grey aluminium bar, attached
  // USB-C cable at one end, ports along both long sides and the far end
  const g = new THREE.Group();
  const L = 1.1, Wd = 0.33, H = 0.175, s = 1.6;          // shown 1.6× so it fills the peek
  const bar = new THREE.Group();
  bar.add(mesh(box(L, H, Wd, 0.07, 6), shell("#5f6367", true, 0.45), 0, H / 2, 0));
  const port = plastic("#060607", 0.8);
  for (const [x, w, h] of [[-0.3, 0.13, 0.05], [-0.1, 0.13, 0.05], [0.14, 0.15, 0.06]]) bar.add(mesh(new THREE.BoxGeometry(w, h, 0.01), port, x, H / 2, Wd / 2 + 0.002));
  for (const [x, w] of [[-0.2, 0.16], [0.1, 0.1]]) bar.add(mesh(new THREE.BoxGeometry(w, 0.025, 0.01), port, x, H / 2, -Wd / 2 - 0.002));
  bar.add(mesh(new THREE.BoxGeometry(0.01, 0.1, 0.14), port, L / 2 + 0.002, H / 2, 0.05));
  bar.add(mesh(new THREE.SphereGeometry(0.01, 8, 6), ledMat("#7fc8ff", 1.6), -L / 2 + 0.12, H + 0.001, 0.08));
  const logo = decal(logoTexture("UGREEN", "#d9dce1", 700), 0.3, 0.075, { metalness: 0.2 });
  logo.rotation.x = -Math.PI / 2;
  logo.position.set(0.1, H + 0.002, 0);
  bar.add(logo);
  bar.scale.setScalar(s);
  g.add(bar);
  const tail = new THREE.CatmullRomCurve3([
    new THREE.Vector3((-L / 2) * s, (H / 2) * s, 0), new THREE.Vector3(-L * s * 0.9, 0.08, 0.15),
    new THREE.Vector3(-L * s * 1.3, 0.05, 0.6), new THREE.Vector3(-L * s * 1.25, 0.05, 1.1)]);
  g.add(new THREE.Mesh(new THREE.TubeGeometry(tail, 50, 0.04, 10), rubber("#2a2c30")));
  g.add(mesh(box(0.14, 0.07, 0.3, 0.03), shell("#5f6367", true), -L * s * 1.25, 0.05, 1.25));
  return { group: g, kind: "hub" };
}

function ssd(d: DeviceLike, f: Finish): Built {
  // 2.5" SATA SSD: 100 × 69.85 × 7 mm (drawn 3× so it fills the peek)
  const g = new THREE.Group();
  g.add(mesh(box(0.7, 0.07, 1.0, 0.012), shell("#2a2c31", true), 0, 0.035, 0));
  const size = (d.name ?? "").match(/\d+\s*(GB|TB)/i)?.[0] ?? "";
  const label = decal(labelTexture([f.logo || (d.brand ?? "SSD"), `SSD ${size}`.trim(), "SATA III 6Gb/s"], "#16171a", "#e8eaee"),
    0.6, 0.45, { transparent: false, metalness: 0, roughness: 0.6 });
  label.rotation.x = -Math.PI / 2;
  label.position.set(0, 0.0705, -0.15);
  g.add(label);
  g.add(mesh(new THREE.BoxGeometry(0.24, 0.035, 0.012), metal("#d9b45a", 0.3), 0.13, 0.035, -0.505));
  g.scale.setScalar(3);
  return { group: g, kind: "ssd" };
}

function printer(d: DeviceLike, v: Variant): Built {
  // LaserJet Pro 4003dn: 381 × 357 × 216 mm, light-grey body, dark top with a
  // sloped output bin, 2-line LCD panel top-right, Tray 2 drawer and the
  // fold-down Tray 1 flap on the front
  const g = new THREE.Group();
  const [W, D, H] = v === "laserjet" ? [3.81, 3.57, 2.16] : [4.0, 3.4, 1.6];
  const light = plastic("#e6e7e8", 0.5), dark = plastic("#3a3b3d", 0.45);
  g.add(mesh(box(W, H, D, 0.1), light, 0, H / 2, 0));
  g.add(mesh(box(W - 0.2, 0.06, D - 0.3, 0.03), dark, 0, H + 0.01, -0.05));
  const bin = mesh(new THREE.BoxGeometry(W * 0.6, 0.02, D * 0.55), plastic("#2a2b2d", 0.6), -0.3, H - 0.1, -0.3);
  bin.rotation.x = 0.12;
  g.add(bin);
  g.add(mesh(new THREE.BoxGeometry(W * 0.62, 0.04, 0.05), plastic("#111"), -0.3, H - 0.16, D / 2 - 0.55));
  const panel = new THREE.Group();
  panel.add(mesh(box(0.95, 0.05, 0.5, 0.02), dark));
  const lcdTex = lcdTexture(["Ready", "HP LaserJet Pro"]);
  const lcd = mesh(new THREE.PlaneGeometry(0.5, 0.18),
    new THREE.MeshStandardMaterial({ map: lcdTex, emissive: "#ffffff", emissiveMap: lcdTex, emissiveIntensity: 0.35 }), -0.12, 0.027, 0);
  lcd.rotation.x = -Math.PI / 2;
  panel.add(lcd);
  panel.add(mesh(new THREE.SphereGeometry(0.03, 10, 8), ledMat(ledOf(d.status)), 0.32, 0.03, -0.1));
  for (const x of [0.22, 0.34]) panel.add(mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.02, 16), plastic("#5a5d63"), x, 0.03, 0.1));
  panel.position.set(W / 2 - 0.6, H + 0.06, D / 2 - 0.4);
  panel.rotation.x = 0.35;
  g.add(panel);
  g.add(mesh(new THREE.BoxGeometry(W - 0.5, 0.012, 0.01), plastic("#b9bbbe"), 0, H * 0.62, D / 2 + 0.002));
  g.add(mesh(new THREE.BoxGeometry(W - 0.3, 0.012, 0.01), plastic("#b9bbbe"), 0, H * 0.3, D / 2 + 0.002));
  g.add(mesh(box(0.8, 0.05, 0.04, 0.02), plastic("#c9cbcf"), 0, H * 0.18, D / 2 + 0.02));
  const logo = decal(roundLogoTexture("hp", "#1f5aa6", false), 0.26, 0.26, { metalness: 0 });
  logo.position.set(-W / 2 + 0.45, H * 0.8, D / 2 + 0.003);
  g.add(logo);
  return { group: g, kind: "printer" };
}

function other(d: DeviceLike, f: Finish): Built {
  const g = new THREE.Group();
  g.add(mesh(box(2.2, 1.0, 1.6, 0.18, 6), bodyMat(f), 0, 0.5, 0));
  const label = decal(logoTexture((d.name ?? d.type ?? "?").trim().slice(0, 18) || "?", "#e9edf2", 600), 1.9, 0.48);
  label.position.set(0, 0.5, 0.801);
  g.add(label);
  g.add(mesh(new THREE.SphereGeometry(0.03, 10, 8), ledMat(ledOf(d.status)), 0.95, 0.85, 0.801));
  return { group: g, kind: "other" };
}

const wrap = (o: THREE.Object3D, kind: Kind): Built => {
  const g = new THREE.Group();
  g.add(o);
  return { group: g, kind };
};

/** Build the model for a device row. */
export function build(d: DeviceLike): Built {
  const kind = kindOf(d);
  const v = variantOf(d, kind);
  const f = finishOf(d);
  // A screen is lit when the device is in use; in stock / being scrapped = off.
  const on = d.status === "active" || d.status === "maintaining" || !d.status;
  switch (kind) {
    case "laptop": return laptop(d, f, on, v);
    case "monitor": return wrap(monitorGroup(d, inchesOf(d) ?? 24, v, on), kind);
    case "set": {
      // a PC and its screen(s) on one desk: monitors side by side, the tower to the right
      const g = new THREE.Group();
      const inch = inchesOf(d) ?? 22, count = monitorsInSet(d), w = inch * 0.2214 + 0.15;
      for (let i = 0; i < count; i++) {
        const m = monitorGroup(d, inch, v, on);
        m.position.x = (i - (count - 1) / 2) * w;
        if (count > 1) m.rotation.y = (i - (count - 1) / 2) * -0.25;
        g.add(m);
      }
      const t = towerGroup({ ...d, brand: "" }, setTower(d));
      t.position.set((count * w) / 2 + 1.4, 0, -0.4);
      g.add(t);
      return { group: g, kind };
    }
    case "desktop": return wrap(towerGroup(d, v), kind);
    case "minipc": return minipc(d);
    case "tablet":
    case "phone": return tablet(d, f, on, v, kind);
    case "mouse": return mouse(f, v);
    case "keyboard": return keyboard(f, v);
    case "cable": return cable(d);
    case "hub": return hub();
    case "ssd": return ssd(d, f);
    case "printer": return printer(d, v);
    default: return other(d, f);
  }
}
