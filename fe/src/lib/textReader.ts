// Ordinary text off a page — names, departments, company and item names — in
// any language, through Tesseract.js. PaddleOCR (ocr.worker.ts) still finds the
// lines and reads serials, codes and numbers, which need no diacritics and are
// where it is fast; no PaddleOCR recogniser reads Vietnamese tone marks.
//
// Which language: Tesseract's own script detector (OSD) does not work on single
// lines, so a few clear lines of a page are tried against one pack per script
// and the most confident wins (checked on vie/chi/jpn/kor/tha/rus samples: right
// every time, by 8+ points). Latin pages read with vie+eng — Vietnamese is Latin
// with diacritics, and the vie pack reads English too.
//
// Memory: ONE Tesseract worker, ever. Each one is tens to 100+ MB of wasm heap,
// and a worker per language (what this first did) is how a phone tab got
// killed and reloaded mid-scan. Switching language reinitialises that worker;
// it is also recycled every RECYCLE_AFTER reads, because Tesseract's heap grows
// over a long session, and terminated when the minutes screen closes.
import { createWorker, PSM, type Worker } from "tesseract.js";

export const LATIN = "vie+eng";
// One pack per script the probe can pick; all are bundled under public/ocr/tess.
export const PROBES = ["chi_sim", "chi_tra", "jpn", "kor", "tha", "rus", "ara", "hin"] as const;
export type Pack = typeof LATIN | (typeof PROBES)[number];

const RECYCLE_AFTER = 150;

const base = () => new URL(import.meta.env.BASE_URL, location.href).href;

let worker: Promise<Worker> | null = null;
let loaded: Pack | null = null;
let reads = 0;
// Every call goes through this chain: one recognise / reinitialise at a time,
// so a language switch never races a read.
let chain: Promise<unknown> = Promise.resolve();

function serial<T>(job: () => Promise<T>): Promise<T> {
  const next = chain.then(job, job);
  chain = next.catch(() => {});
  return next;
}

async function create(pack: Pack): Promise<Worker> {
  const w = await createWorker(pack, 1, {
    workerPath: `${base()}ocr/tess/worker.min.js`,
    corePath: `${base()}ocr/tess/`,
    langPath: `${base()}ocr/tess/lang`,
    gzip: true,
    // A blob: worker would need `worker-src blob:` in the CSP; the file is
    // same-origin, so load it directly.
    workerBlobURL: false,
  });
  await w.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, preserve_interword_spaces: "1" });
  return w;
}

async function ready(pack: Pack): Promise<Worker> {
  if (worker && reads >= RECYCLE_AFTER) await stopText();
  if (!worker) {
    worker = create(pack);
    loaded = pack;
    worker.catch(() => {
      worker = null;
      loaded = null;
    });
    return worker;
  }
  const w = await worker;
  if (loaded !== pack) {
    await w.reinitialize(pack, 1);
    await w.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, preserve_interword_spaces: "1" });
    loaded = pack;
  }
  return w;
}

/** Free the worker (leaving the minutes screen, or recycling). */
export async function stopText() {
  const w = worker;
  worker = null;
  loaded = null;
  reads = 0;
  if (w) await w.then((x) => x.terminate()).catch(() => {});
}

export type TextRead = { text: string; confidence: number; ms: number };

/** CJK packs put a space between every character; a name has none. */
function tidy(text: string, pack: Pack) {
  const t = text.replace(/\s+/g, " ").trim();
  return /^(chi|jpn|kor)/.test(pack) ? t.replace(/(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]) (?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])/gu, "") : t;
}

/** One line image (a crop of the frame, ~64 px tall) → text in `pack`. */
export function readLine(image: HTMLCanvasElement, pack: Pack): Promise<TextRead> {
  return serial(async () => {
    const w = await ready(pack);
    const t = performance.now();
    const r = await w.recognize(image);
    reads++;
    return { text: tidy(r.data.text, pack), confidence: r.data.confidence, ms: performance.now() - t };
  });
}

/**
 * Pick the pack for a page from a few of its clear text lines. Latin is tried
 * first and kept unless it plainly fails — the common case costs one read per
 * line; other scripts are probed (on the same worker) only then.
 */
export async function detectPack(lines: HTMLCanvasElement[]): Promise<Pack> {
  // Clear lines only: a blurred or tiny crop scores low in EVERY language and
  // would send the probe through all eight packs for nothing.
  const sample = lines.filter((c) => c.width >= 3 * c.height).slice(0, 3);
  if (sample.length < 3) return LATIN;
  const score = async (pack: Pack) => {
    let sum = 0;
    for (const l of sample) sum += (await readLine(l, pack)).confidence;
    return sum / sample.length;
  };
  const latin = await score(LATIN);
  if (latin >= 60) return LATIN;
  let best: Pack = LATIN;
  let bestScore = latin;
  for (const p of PROBES) {
    const s = await score(p);
    if (s > bestScore + 5) {
      best = p;
      bestScore = s;
    }
  }
  return best;
}

/** Fetch the default packs while the phone is idle. */
export function prefetchText() {
  for (const f of ["ocr/tess/worker.min.js", "ocr/tess/tesseract-core-simd-lstm.wasm.js", "ocr/tess/lang/vie.traineddata.gz", "ocr/tess/lang/eng.traineddata.gz"]) {
    fetch(base() + f).catch(() => {});
  }
}
