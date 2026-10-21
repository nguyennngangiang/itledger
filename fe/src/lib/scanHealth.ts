// A breadcrumb for "the scan screen died": while the camera is scanning, every
// few seconds a small record goes into sessionStorage (which survives the
// reload a browser does after killing a tab for using too much memory). A
// clean stop — leaving the screen, hiding the tab — removes it. Finding one on
// the next load means the tab was killed; it is sent to the server log
// (POST /scan/diag), the only way to learn what a phone did that cannot be
// reproduced on a desk.
import { request } from "../api/client";

const KEY = "itledger.scan.health";

type Crumb = {
  active: true;
  mode: string;
  since: number;
  at: number;
  frames: number;
  backend: string;
  heapMB?: number;
  // The last step reached — what was running when the tab died.
  stage?: string;
  test?: string;
};

// Whatever the LAST page load left behind, captured the moment this module
// loads — before any scan screen mounts and writes a fresh crumb over it
// (children's effects run before their parent's, so reading it later would
// find this load's own crumb and report every normal visit as a crash).
let previous: string | null = null;
try {
  previous = sessionStorage.getItem(KEY);
  sessionStorage.removeItem(KEY);
} catch {
  previous = null;
}

// A device whose scan was killed while running on WebGPU runs WASM from then
// on. Measured on an iPhone (iOS 18.7, Safari 26.2): onnxruntime on WebGPU got
// the tab killed after 10–15 s, every time; WASM stays flat at ~100–200 MB.
const NO_WEBGPU = "itledger.ocr.noWebgpu";

export function webgpuBanned(): boolean {
  try {
    return localStorage.getItem(NO_WEBGPU) === "1";
  } catch {
    return false;
  }
}

function parse(raw: string | null): Crumb | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Crumb;
    // Only a fresh one: an old crumb is a tab that was simply abandoned.
    return c.active && Date.now() - c.at <= 10 * 60_000 ? c : null;
  } catch {
    return null;
  }
}

const killed = parse(previous);
if (killed?.backend.startsWith("webgpu")) {
  try {
    localStorage.setItem(NO_WEBGPU, "1");
  } catch {
    /* ignore */
  }
}

/** The last load's scan was killed soon after it started — the next load
 * should not walk straight back into the Scan screen (a crash loop). */
export function lastScanWasKilled(): boolean {
  return !!killed && killed.at - killed.since < 30_000;
}

let frames = 0;
let backend = "?";
let stage = "start";
let writeNow: (() => void) | null = null;
export const countFrame = () => void frames++;
export const noteBackend = (b: string) => void (backend = b);
/** Mark a step of the scan (camera on, OCR ready, …), written immediately. */
export function noteStage(s: string) {
  stage = s;
  writeNow?.();
}

/** Start leaving breadcrumbs for `mode`; returns the clean-stop function. */
export function watchScan(mode: string): () => void {
  const since = Date.now();
  frames = 0;
  const write = () => {
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    const crumb: Crumb = {
      active: true, mode, since, at: Date.now(), frames, backend, stage,
      heapMB: mem ? Math.round(mem.usedJSHeapSize / 1e6) : undefined,
      test: new URLSearchParams(location.search).get("scan") ?? undefined,
    };
    try {
      sessionStorage.setItem(KEY, JSON.stringify(crumb));
    } catch {
      // private mode / quota: diagnostics are optional
    }
  };
  stage = "start";
  write();
  writeNow = write;
  // Every second: a phone that kills the tab 5 s in left only one crumb before.
  const timer = window.setInterval(write, 1000);
  // Leaving the page on purpose (a link, a reload, closing the tab) fires
  // pagehide before React can unmount anything; a browser killing the tab
  // fires nothing. Clearing here is what keeps "went to another page" from
  // being reported as a crash.
  const left = () => {
    clearInterval(timer);
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  };
  window.addEventListener("pagehide", left);
  return () => {
    clearInterval(timer);
    window.removeEventListener("pagehide", left);
    writeNow = null;
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  };
}

/** On load: a breadcrumb still marked active means the last scan was killed. */
export function reportKilledScan() {
  const crumb = killed && previous ? killed : null;
  previous = null; // once per load
  if (!crumb) return;
  const nav = navigator as Navigator & { deviceMemory?: number };
  request("/scan/diag", {
    method: "POST",
    body: JSON.stringify({
      ...crumb,
      ran_s: Math.round((crumb.at - crumb.since) / 1000),
      ua: navigator.userAgent.slice(0, 300),
      device_memory: nav.deviceMemory ?? null,
      screen: `${screen.width}x${screen.height}@${window.devicePixelRatio}`,
    }),
  }).catch(() => {});
}
