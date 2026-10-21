// The arithmetic around the two PaddleOCR models — no DOM, no onnxruntime — so
// the browser worker (ocr.worker.ts) and a Node check against real scans run
// the exact same code.
//
//   detection   PP-OCRv5_mobile_det   BGR, ImageNet mean/std, NCHW, sides ÷32
//               → one probability map; DB post-process turns it into boxes
//   recognition en_PP-OCRv5_mobile_rec  BGR, (x/255 − .5)/.5, height 48
//               → per-column class scores; CTC decode against dict.txt
//
// Boxes are axis-aligned on purpose. A sticker is held roughly level to the
// camera; the rotated-rectangle step of the reference DB post-process costs
// more than it buys here.

export type RGBA = { data: Uint8ClampedArray | Uint8Array; width: number; height: number };
export type Box = { x: number; y: number; w: number; h: number; score: number };
export type Line = { text: string; score: number; box: Box };

// Fixed detector input. 480×192 is ~2.3× cheaper than 640×320 (measured) and
// still resolves serial-sized text in the viewfinder strip it is fed.
export const DET_W = 480;
export const DET_H = 192;
export const REC_H = 48;
export const REC_W = 320;
export const REC_BATCH = 4;
// Recognition cost grows with input width (measured: 160 px ≈ half of 320), so
// the batch is cut at the narrowest bucket that fits the widest line. Two
// buckets only — every distinct shape is another set of GPU kernels to compile.
export const REC_WIDTHS = [160, 320] as const;

export function recWidth(boxes: Box[]): number {
  const need = Math.max(...boxes.map((b) => Math.round((b.w / b.h) * REC_H)), 1);
  return REC_WIDTHS.find((w) => w >= need) ?? REC_WIDTHS[REC_WIDTHS.length - 1];
}

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/** RGBA (already at detector size, sides ÷32) → NCHW BGR float, normalised. */
export function detInput(img: RGBA, out: Float32Array<ArrayBuffer> = new Float32Array(3 * img.width * img.height)): Float32Array<ArrayBuffer> {
  const n = img.width * img.height;
  const d = img.data;
  // Model channel order is B, G, R; source pixel order is R, G, B.
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    out[i] = (d[p + 2] / 255 - MEAN[0]) / STD[0];
    out[n + i] = (d[p + 1] / 255 - MEAN[1]) / STD[1];
    out[2 * n + i] = (d[p] / 255 - MEAN[2]) / STD[2];
  }
  return out;
}

/**
 * DB post-process: threshold the probability map, flood-fill connected
 * regions, keep those whose mean probability clears `boxThresh`, and grow each
 * box by the "unclip" margin the model was trained to leave off.
 */
export function detBoxes(
  prob: Float32Array,
  w = DET_W,
  h = DET_H,
  { thresh = 0.3, boxThresh = 0.5, unclip = 1.6, minSide = 4 } = {},
): Box[] {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const boxes: Box[] = [];
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || prob[start] < thresh) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let minX = w, minY = h, maxX = 0, maxY = 0, sum = 0, count = 0;
    while (top) {
      const i = stack[--top];
      const x = i % w;
      const y = (i - x) / w;
      sum += prob[i];
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      // 4-neighbourhood is enough for text strokes the model has already joined.
      if (x > 0 && !seen[i - 1] && prob[i - 1] >= thresh) { seen[i - 1] = 1; stack[top++] = i - 1; }
      if (x < w - 1 && !seen[i + 1] && prob[i + 1] >= thresh) { seen[i + 1] = 1; stack[top++] = i + 1; }
      if (y > 0 && !seen[i - w] && prob[i - w] >= thresh) { seen[i - w] = 1; stack[top++] = i - w; }
      if (y < h - 1 && !seen[i + w] && prob[i + w] >= thresh) { seen[i + w] = 1; stack[top++] = i + w; }
    }
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    if (Math.min(bw, bh) < minSide) continue;
    const score = sum / count;
    if (score < boxThresh) continue;
    const off = (bw * bh * unclip) / (2 * (bw + bh));
    const x = Math.max(0, minX - off);
    const y = Math.max(0, minY - off);
    boxes.push({
      x, y,
      w: Math.min(w, maxX + 1 + off) - x,
      h: Math.min(h, maxY + 1 + off) - y,
      score,
    });
  }
  // Reading order: top to bottom, then left to right.
  return boxes.sort((a, b) => (Math.abs(a.y - b.y) > a.h / 2 ? a.y - b.y : a.x - b.x));
}

/**
 * Crop each box out of `src` and write it into one batch tensor
 * [boxes, 3, REC_H, width]: height scaled to 48, width by aspect (capped at
 * `width`, squeezed beyond that), right side padded with 0. Bilinear sampling —
 * crops are tiny, a JS loop over them is well under a millisecond.
 */
export function recInput(src: RGBA, boxes: Box[], width: number = REC_W, batch = boxes.length): Float32Array {
  // Rows past boxes.length stay 0 — padding to a fixed batch size.
  const out = new Float32Array(batch * 3 * REC_H * width);
  const plane = REC_H * width;
  const { data, width: sw, height: sh } = src;
  for (let b = 0; b < boxes.length; b++) {
    const box = boxes[b];
    const tw = Math.max(1, Math.min(width, Math.round((box.w / box.h) * REC_H)));
    const sx = box.w / tw;
    const sy = box.h / REC_H;
    const base = b * 3 * plane;
    for (let y = 0; y < REC_H; y++) {
      const fy = Math.min(sh - 1, Math.max(0, box.y + (y + 0.5) * sy - 0.5));
      const y0 = Math.floor(fy);
      const y1 = Math.min(sh - 1, y0 + 1);
      const wy = fy - y0;
      for (let x = 0; x < tw; x++) {
        const fx = Math.min(sw - 1, Math.max(0, box.x + (x + 0.5) * sx - 0.5));
        const x0 = Math.floor(fx);
        const x1 = Math.min(sw - 1, x0 + 1);
        const wx = fx - x0;
        const p00 = (y0 * sw + x0) * 4, p01 = (y0 * sw + x1) * 4;
        const p10 = (y1 * sw + x0) * 4, p11 = (y1 * sw + x1) * 4;
        const o = y * width + x;
        for (let c = 0; c < 3; c++) {
          const v =
            (data[p00 + c] * (1 - wx) + data[p01 + c] * wx) * (1 - wy) +
            (data[p10 + c] * (1 - wx) + data[p11 + c] * wx) * wy;
          // RGB source → BGR planes.
          out[base + (2 - c) * plane + o] = (v / 255 - 0.5) / 0.5;
        }
      }
    }
  }
  return out;
}

/** Greedy CTC decode. Class 0 is the blank; 1..dict.length are the dictionary;
 * the last class is a space. */
export function ctcDecode(
  logits: Float32Array,
  batch: number,
  steps: number,
  classes: number,
  dict: string[],
): { text: string; score: number }[] {
  const out: { text: string; score: number }[] = [];
  for (let b = 0; b < batch; b++) {
    let text = "";
    let sum = 0;
    let n = 0;
    let prev = -1;
    for (let t = 0; t < steps; t++) {
      const off = (b * steps + t) * classes;
      let best = 0;
      let bestV = logits[off];
      for (let c = 1; c < classes; c++) {
        const v = logits[off + c];
        if (v > bestV) { bestV = v; best = c; }
      }
      if (best !== 0 && best !== prev) {
        text += best <= dict.length ? dict[best - 1] : " ";
        sum += bestV;
        n++;
      }
      prev = best;
    }
    out.push({ text, score: n ? sum / n : 0 });
  }
  return out;
}

/** Map a box from detector space back onto the source the ROI was cut from. */
export function scaleBox(b: Box, sx: number, sy: number, ox = 0, oy = 0): Box {
  return { x: b.x * sx + ox, y: b.y * sy + oy, w: b.w * sx, h: b.h * sy, score: b.score };
}

/**
 * One recognition row from pixels the browser already cropped and scaled
 * (canvas drawImage): RGBA `width`×REC_H, of which the first `tw` columns are
 * the line. Written into slot `b` of a reused batch buffer; columns past `tw`
 * are 0 — the same padding recInput produces.
 */
export function recRow(out: Float32Array, b: number, data: Uint8ClampedArray, width: number, tw: number) {
  const plane = REC_H * width;
  const base = b * 3 * plane;
  for (let y = 0; y < REC_H; y++) {
    for (let x = 0; x < width; x++) {
      const o = y * width + x;
      if (x >= tw) {
        out[base + o] = 0;
        out[base + plane + o] = 0;
        out[base + 2 * plane + o] = 0;
        continue;
      }
      const p = o * 4;
      out[base + o] = (data[p + 2] / 255 - 0.5) / 0.5; // B
      out[base + plane + o] = (data[p + 1] / 255 - 0.5) / 0.5; // G
      out[base + 2 * plane + o] = (data[p] / 255 - 0.5) / 0.5; // R
    }
  }
}
