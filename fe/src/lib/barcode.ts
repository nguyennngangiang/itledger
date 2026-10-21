// In-browser barcode / QR reading for the Scan screen.
//
// iOS Safari has no native BarcodeDetector, so this uses the zxing-wasm ponyfill
// everywhere — one decoder means one behaviour to reason about. The ponyfill
// fetches its .wasm from jsDelivr by default; the office network should not need
// a CDN to scan a sticker, so the file is bundled and served by our own origin.
import { BarcodeDetector, setZXingModuleOverrides } from "barcode-detector/ponyfill";
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";

setZXingModuleOverrides({
  locateFile: (path: string, prefix: string) =>
    path.endsWith(".wasm") ? wasmUrl : prefix + path,
});

// Device stickers print serials as Code 128 / Code 39 almost without exception;
// QR and DataMatrix turn up on newer labels. EAN/UPC is left out on purpose —
// it is the retail box's product code, the same for every unit, and would
// otherwise be "scanned" as a serial.
const FORMATS = ["code_128", "code_39", "code_93", "qr_code", "data_matrix", "itf", "codabar"] as const;

export type Detected = {
  value: string;
  format: string;
  // Corner points in VIDEO pixel space; the overlay scales them to the screen.
  points: { x: number; y: number }[];
};

let detector: BarcodeDetector | null = null;

export async function detect(source: CanvasImageSource | ImageData): Promise<Detected[]> {
  detector ??= new BarcodeDetector({ formats: [...FORMATS] });
  const found = await detector.detect(source as ImageBitmapSource);
  return found
    .map((b) => ({
      value: b.rawValue.trim(),
      format: b.format,
      points: b.cornerPoints.map((p) => ({ x: p.x, y: p.y })),
    }))
    .filter((b) => b.value.length >= 4);
}
