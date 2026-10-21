// On-device OCR for the Scan screen, off the main thread.
//
// The camera loop posts one ImageBitmap per frame: the viewfinder strip, cut
// and scaled by the browser (createImageBitmap) before it gets here. The
// worker answers with the text lines it read and how long each stage took.
//
// Speed comes from not running the whole pipeline on every frame:
//   * detection (where is text?) runs on the first frame, when the picture
//     moves, and every DET_EVERY frames — otherwise the last boxes are reused;
//   * recognition (what does it say?) runs only on lines whose reading has not
//     settled yet, batched into one call, at the narrowest width that fits;
//   * a frame that is the same as the last one is skipped outright.
// onnxruntime-web runs on WebGPU where the browser has it, else WASM.
import type * as OrtNs from "onnxruntime-web/webgpu";

// The runtime is chosen at init, not imported up front: the WebGPU build ships
// a 25 MB "asyncify" wasm, the WASM-only build a 12 MB one. On iPhones (WASM
// only) loading the big one meant Safari compiling twice the machine code for
// nothing — memory a phone tab does not have to spare.
let ort: typeof OrtNs;
import {
  DET_H, DET_W, REC_BATCH, REC_H,
  ctcDecode, detBoxes, detInput, recRow, recWidth,
  type Box,
} from "./ocrCore";

export type OcrLine = { text: string; score: number; box: Box };
export type OcrResult = {
  lines: OcrLine[];
  ms: { det: number; rec: number; total: number };
  detRan: boolean;
  skipped: boolean;
};
export type Backend = "webgpu" | "wasm";

type InMsg =
  | { type: "init"; base: string; forceWasm?: boolean }
  | { type: "frame"; id: number; bitmap: ImageBitmap; mode?: Mode }
  | { type: "fail"; id: number }; // test hook: make the next frame throw

// "strip": a sticker in the viewfinder band — small input, few lines.
// "page": a whole sheet of paper — larger input, oriented like the frame, and
// many lines, read a few per frame until all have settled.
export type Mode = "strip" | "page";
const SIZES: Record<Mode, { w: number; h: number; lines: number }> = {
  strip: { w: DET_W, h: DET_H, lines: REC_BATCH * 2 },
  // 736×416: ~40% less memory and time than 960×544, still reads the
  // record's body text (checked on the same fixtures).
  page: { w: 736, h: 416, lines: 48 },
};
let mode: Mode = "strip";

const DET_EVERY = 5; // frames between forced re-detections
const MOTION_SKIP = 2.5; // mean |Δ| on a 32×16 grey thumb below which a frame is "the same"
const MOTION_REDETECT = 12; // above which the old boxes are stale

let det: OrtNs.InferenceSession | null = null;
let rec: OrtNs.InferenceSession | null = null;
let dict: string[] = [];
let backend: Backend = "wasm";

let frames = 0;
let boxes: Box[] = [];
// Settled readings by box index — a line read the same twice is not re-read
// until the next detection.
let settled: (OcrLine | null)[] = [];
let lastRead: (string | null)[] = [];
// Most recent reading per box, settled or not — what is shown while a line is
// still being confirmed.
let latest: (OcrLine | null)[] = [];
let lastThumb: Float32Array | null = null;
let lastResult: OcrResult | null = null;

// Buffers reused frame to frame: allocating a fresh 3–6 MB Float32Array and a
// full-frame getImageData every frame produced garbage faster than a phone
// collected it.
const detBuffers = new Map<string, Float32Array<ArrayBuffer>>();
const recBuffers = new Map<string, Float32Array<ArrayBuffer>>();
const recCanvas = new OffscreenCanvas(320, REC_H);
const recCtx = recCanvas.getContext("2d", { willReadFrequently: true })!;
let failures = 0;
let failPending = 0; // test hook: frames still to fail
const detCanvas = new OffscreenCanvas(DET_W, DET_H); // resized per frame
const detCtx = detCanvas.getContext("2d", { willReadFrequently: true })!;
const thumbCanvas = new OffscreenCanvas(32, 16);
const thumbCtx = thumbCanvas.getContext("2d", { willReadFrequently: true })!;

async function init(base: string, forceWasm = false) {
  ort = forceWasm
    ? ((await import("onnxruntime-web/wasm")) as unknown as typeof OrtNs)
    : await import("onnxruntime-web/webgpu");
  // Threads need cross-origin isolation, which would break Google Fonts.
  ort.env.wasm.numThreads = 1;
  const gpu = (self.navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  const useGpu = !!gpu && !!(await gpu.requestAdapter().catch(() => null));
  const opts: OrtNs.InferenceSession.SessionOptions = {
    executionProviders: useGpu && !forceWasm ? ["webgpu", "wasm"] : ["wasm"],
    graphOptimizationLevel: "all",
    // The CPU arena grows to the largest shape ever seen and never gives the
    // memory back; with several input shapes that is a slow leak on a phone.
    enableCpuMemArena: false,
    enableMemPattern: false,
  };
  // One after the other: the WebGPU EP refuses a second session while the
  // first is still being created ("another WebGPU EP inference session is
  // being created"). The downloads still overlap.
  const files = [`${base}ocr/v5/det.onnx`, `${base}ocr/v5/rec.onnx`].map((u) =>
    fetch(u).then((res) => res.arrayBuffer()).then((b) => new Uint8Array(b)),
  );
  const words = fetch(`${base}ocr/v5/dict.txt`).then((res) => res.text());
  det = await ort.InferenceSession.create(await files[0], opts);
  rec = await ort.InferenceSession.create(await files[1], opts);
  dict = (await words).split("\n").slice(0, -1);
  backend = useGpu && !forceWasm ? "webgpu" : "wasm";

  // Warm-up: the first run compiles every GPU kernel. Do it now for the
  // sticker shapes — not for the page shapes: WASM memory only ever grows, and
  // running a 736×416 detector here would leave a sticker scan carrying the
  // page's peak for the rest of the session. Page shapes warm on first use.
  const t = performance.now();
  await det.run({ [det.inputNames[0]]: new ort.Tensor("float32", new Float32Array(3 * DET_W * DET_H), [1, 3, DET_H, DET_W]) });
  for (const w of [160, 320]) for (const b of [1, REC_BATCH]) {
    await rec.run({ [rec.inputNames[0]]: new ort.Tensor("float32", new Float32Array(b * 3 * REC_H * w), [b, 3, REC_H, w]) });
  }
  return performance.now() - t;
}

function iou(a: Box, b: Box) {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = x * y;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

/** Grey 32×16 thumbnail, for "has the picture changed?" */
function thumb(bitmap: ImageBitmap): Float32Array {
  thumbCtx.drawImage(bitmap, 0, 0, 32, 16);
  const d = thumbCtx.getImageData(0, 0, 32, 16).data;
  const out = new Float32Array(32 * 16);
  for (let i = 0; i < out.length; i++) out[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3;
  return out;
}

function motion(a: Float32Array, b: Float32Array) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

async function frame(bitmap: ImageBitmap, m: Mode): Promise<OcrResult> {
  if (failPending > 0) {
    failPending--;
    throw new Error("test: forced failure");
  }
  if (m !== mode) {
    // A different kind of picture: nothing from the last one carries over.
    mode = m;
    boxes = [];
    settled = [];
    lastRead = [];
    latest = [];
    lastThumb = null;
    lastResult = null;
  }
  const t0 = performance.now();
  frames++;
  const th = thumb(bitmap);
  const moved = lastThumb ? motion(th, lastThumb) : Infinity;
  lastThumb = th;

  if (lastResult && moved < MOTION_SKIP && settled.every(Boolean)) {
    bitmap.close();
    return { ...lastResult, skipped: true, ms: { det: 0, rec: 0, total: performance.now() - t0 } };
  }

  const W = bitmap.width;
  const H = bitmap.height;

  let detMs = 0;
  // Periodic re-detection only while the picture moves; a still frame has
  // nothing new to find.
  const detRan = !boxes.length || moved > MOTION_REDETECT || (frames % DET_EVERY === 0 && moved > MOTION_SKIP);
  if (detRan) {
    const d0 = performance.now();
    // Page mode follows the frame's orientation: a portrait phone shot gets
    // a portrait detector input instead of being squashed into a landscape one.
    const size = SIZES[mode];
    const [dw, dh] = mode === "page" && H > W ? [size.h, size.w] : [size.w, size.h];
    if (detCanvas.width !== dw || detCanvas.height !== dh) {
      detCanvas.width = dw;
      detCanvas.height = dh;
    }
    detCtx.drawImage(bitmap, 0, 0, dw, dh);
    const key = `${dw}x${dh}`;
    let buf = detBuffers.get(key);
    if (!buf) detBuffers.set(key, (buf = new Float32Array(3 * dw * dh)));
    const input = detInput(detCtx.getImageData(0, 0, dw, dh), buf);
    const out = await det!.run({ [det!.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, dh, dw]) });
    const prob = (await out[det!.outputNames[0]].getData()) as Float32Array;
    const oldBoxes = boxes;
    const sx = W / dw;
    const sy = H / dh;
    boxes = detBoxes(prob, dw, dh)
      .map((b) => ({ ...b, x: b.x * sx, y: b.y * sy, w: b.w * sx, h: b.h * sy }))
      // A text line is wider than tall and not a speck.
      .filter((b) => b.w > b.h * 1.2 && b.h > 8)
      // The longest lines first: serials are long; "65W" is not.
      .sort((a, b) => b.w - a.w)
      .slice(0, size.lines)
      // Back into reading order once the longest lines have been chosen.
      .sort((a, b) => (Math.abs(a.y - b.y) > a.h / 2 ? a.y - b.y : a.x - b.x));
    // A box that is the same line as before keeps what was read from it.
    const prev = { boxes: oldBoxes, settled, lastRead, latest };
    const carry = boxes.map((b) => {
      let best = -1, bestIou = 0.6;
      prev.boxes.forEach((o, j) => {
        const v = iou(b, o);
        if (v > bestIou) { bestIou = v; best = j; }
      });
      return best;
    });
    settled = carry.map((j) => (j >= 0 ? prev.settled[j] && { ...prev.settled[j]!, box: boxes[carry.indexOf(j)] } : null));
    lastRead = carry.map((j) => (j >= 0 ? prev.lastRead[j] : null));
    latest = carry.map((j) => (j >= 0 ? prev.latest[j] : null));
    detMs = performance.now() - d0;
  }

  let recMs = 0;
  // Narrow lines first and together: a batch costs what its widest line
  // needs, so mixing a short "S/N" with a long serial doubles the short one.
  const todo = boxes
    .map((_, i) => i)
    .filter((i) => !settled[i])
    .sort((a, b) => boxes[a].w / boxes[a].h - boxes[b].w / boxes[b].h)
    .slice(0, REC_BATCH);
  if (todo.length) {
    const r0 = performance.now();
    const batch = todo.map((i) => boxes[i]);
    const width = recWidth(batch);
    // Only two batch sizes ever reach the model (1, or padded to REC_BATCH):
    // each new input shape is another round of GPU kernel compilation, which
    // the warm-up has already paid for these.
    const size = batch.length === 1 ? 1 : REC_BATCH;
    // Each line is cut and scaled by the canvas (drawImage), not by a JS
    // loop over a full-frame copy of the pixels.
    const key = `${size}x${width}`;
    let input = recBuffers.get(key);
    if (!input) recBuffers.set(key, (input = new Float32Array(size * 3 * REC_H * width)));
    input.fill(0);
    if (recCanvas.width !== width) recCanvas.width = width;
    batch.forEach((b, k) => {
      const tw = Math.max(1, Math.min(width, Math.round((b.w / b.h) * REC_H)));
      recCtx.clearRect(0, 0, width, REC_H);
      recCtx.drawImage(bitmap, b.x, b.y, b.w, b.h, 0, 0, tw, REC_H);
      recRow(input!, k, recCtx.getImageData(0, 0, width, REC_H).data, width, tw);
    });
    const out = await rec!.run({ [rec!.inputNames[0]]: new ort.Tensor("float32", input, [size, 3, REC_H, width]) });
    const o = out[rec!.outputNames[0]];
    const [, T, C] = o.dims as number[];
    const texts = ctcDecode((await o.getData()) as Float32Array, batch.length, T, C, dict);
    todo.forEach((i, k) => {
      const line = { text: texts[k].text, score: texts[k].score, box: boxes[i] };
      // Two identical reads settle a line, junk included: re-reading a "."
      // every frame would cost as much as reading a serial.
      if (lastRead[i] === line.text) settled[i] = line;
      lastRead[i] = line.text;
      latest[i] = line;
    });
    recMs = performance.now() - r0;
  }

  bitmap.close();
  const lines = boxes.map((_, i) => settled[i] ?? latest[i]).filter((l): l is OcrLine => !!l && !!l.text);
  lastResult = { lines, ms: { det: detMs, rec: recMs, total: performance.now() - t0 }, detRan, skipped: false };
  return lastResult;
}

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  if (msg.type === "fail") {
    failPending++;
    return;
  }
  if (msg.type === "init") {
    try {
      const warmMs = await init(msg.base, msg.forceWasm);
      self.postMessage({ type: "ready", backend, warmMs });
    } catch (err) {
      self.postMessage({ type: "error", id: -1, message: String((err as Error)?.message ?? err) });
    }
    return;
  }
  try {
    const result = await frame(msg.bitmap, msg.mode ?? "strip");
    failures = 0;
    self.postMessage({ type: "result", id: msg.id, result });
  } catch (err) {
    // Whatever failed, the frame's pixels must not outlive it.
    msg.bitmap.close();
    failures++;
    self.postMessage({ type: "error", id: msg.id, message: String((err as Error)?.message ?? err) });
    // A GPU that is gone (iOS locks the screen, the tab is backgrounded) fails
    // every run from then on. Say so once, so the page restarts the worker
    // instead of feeding it frames that can only fail.
    if (failures === 3) self.postMessage({ type: "lost" });
  }
};
