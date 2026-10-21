// Main-thread handle on the OCR worker (ocr.worker.ts). One worker per page
// load: the models take a few seconds to compile on first use and are kept.
import type { Backend, Mode, OcrResult } from "./ocr.worker";
import { countFrame, noteBackend, noteStage, webgpuBanned } from "./scanHealth";

/** Every browser on iOS/iPadOS is WebKit, and WebKit's WebGPU got the scan
 * tab killed in 10–15 s on a real iPhone (see scanHealth.ts). WASM there. */
const IOS_WEBKIT =
  typeof navigator !== "undefined" &&
  (/iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1));

export type { Backend, Mode, OcrLine, OcrResult } from "./ocr.worker";

type Pending = { resolve: (r: OcrResult) => void; reject: (e: Error) => void };
export type OcrState = { status: "loading" } | { status: "ready"; backend: Backend; recovered: number } | { status: "error"; message: string };

let worker: Worker | null = null;
let ready: Promise<{ backend: Backend; warmMs: number }> | null = null;
const pending = new Map<number, Pending>();
let nextId = 1;
let isReady = false;
// How many times the worker has been restarted after losing its GPU / dying.
// The second restart drops to WASM: a GPU that keeps going away is not worth
// a third try.
let restarts = 0;
let state: OcrState = { status: "loading" };
const listeners = new Set<(s: OcrState) => void>();

export const isOcrReady = () => isReady;

function setState(s: OcrState) {
  state = s;
  for (const l of listeners) l(s);
}

/** Current state now and on every change; returns an unsubscribe. */
export function onOcrState(cb: (s: OcrState) => void) {
  listeners.add(cb);
  cb(state);
  return () => listeners.delete(cb);
}

function teardown(reason: string) {
  isReady = false;
  worker?.terminate();
  worker = null;
  ready = null;
  for (const p of pending.values()) p.reject(new Error(reason));
  pending.clear();
}

/** Restart after the worker lost its GPU or died — with a back-off, so a
 * broken device can never become a tight crash loop. */
function recover(reason: string) {
  teardown(reason);
  restarts++;
  setState({ status: "loading" });
  const wait = Math.min(8000, 1000 * 2 ** (restarts - 1));
  window.setTimeout(() => {
    startOcr().catch(() => {});
  }, wait);
}

export function startOcr() {
  if (ready) return ready;
  setState({ status: "loading" });
  noteStage("ocr-loading");
  const w = new Worker(new URL("./ocr.worker.ts", import.meta.url), { type: "module" });
  worker = w;
  ready = new Promise((resolve, reject) => {
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === "ready") {
        isReady = true;
        setState({ status: "ready", backend: m.backend, recovered: restarts });
        noteBackend(`${m.backend}${restarts ? `+r${restarts}` : ""}`);
        noteStage("ocr-ready");
        resolve({ backend: m.backend, warmMs: m.warmMs });
      } else if (m.type === "result") {
        pending.get(m.id)?.resolve(m.result);
        pending.delete(m.id);
      } else if (m.type === "error") {
        const p = pending.get(m.id);
        if (p) {
          p.reject(new Error(m.message));
          pending.delete(m.id);
        } else reject(new Error(m.message));
      } else if (m.type === "lost") {
        if (worker === w) recover("OCR worker lost its device");
      }
    };
    w.onerror = (e) => {
      if (!isReady) reject(new Error(e.message || "OCR worker failed"));
      else if (worker === w) recover(e.message || "OCR worker crashed");
    };
  });
  w.postMessage({ type: "init", base: new URL(import.meta.env.BASE_URL, location.href).href, forceWasm: restarts >= 2 || IOS_WEBKIT || webgpuBanned() });
  // A failed start must be retryable on the next visit, not cached forever.
  ready.catch((e: Error) => {
    if (worker === w) teardown(e.message);
    setState({ status: "error", message: e.message });
  });
  return ready;
}

/** Hands the bitmap to the worker (transferred, not copied). */
export function readFrame(bitmap: ImageBitmap, mode: Mode = "strip"): Promise<OcrResult> {
  if (!worker || !isReady) {
    // Not ours to keep: an un-transferred bitmap is GPU memory until closed.
    bitmap.close();
    return Promise.reject(new Error("OCR not ready"));
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    countFrame();
    worker!.postMessage({ type: "frame", id, bitmap, mode }, [bitmap]);
  });
}

/** Test hook (`?ocrbench`): make the worker's next frame fail. */
export function failNextFrame() {
  worker?.postMessage({ type: "fail", id: 0 });
}

/** Warm the HTTP cache for the models and runtime while the phone is idle, so
 * opening Scan does not start with an 18 MB download. Nothing is compiled. */
export function prefetchOcr() {
  const base = new URL(import.meta.env.BASE_URL, location.href).href;
  for (const f of ["ocr/v5/det.onnx", "ocr/v5/rec.onnx", "ocr/v5/dict.txt"]) {
    fetch(base + f).catch(() => {});
  }
}

/** `?ocrbench` in the URL: every 100 processed frames, log p50/p95 of the
 * per-frame OCR time to the console — numbers off a real phone, not a guess. */
const BENCH = typeof location !== "undefined" && new URLSearchParams(location.search).has("ocrbench");
const samples: number[] = [];
export const bench = {
  push(ms: number) {
    if (!BENCH) return;
    samples.push(ms);
    if (samples.length < 100) return;
    const sorted = [...samples].sort((a, b) => a - b);
    console.info(`[ocrbench] n=100 p50=${sorted[49].toFixed(1)}ms p95=${sorted[94].toFixed(1)}ms`);
    samples.length = 0;
  },
};

// Same switch exposes the worker to the console / an automated check, so a
// phone's DevTools (or a headless run) can time real frames.
if (BENCH) (window as unknown as { __ocr: unknown }).__ocr = { startOcr, readFrame, failNextFrame, onOcrState };
