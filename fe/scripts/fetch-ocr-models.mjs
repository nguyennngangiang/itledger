// Puts what the Scan screen's on-device OCR needs into public/, before `vite build`
// (wired as `prebuild`, so the autodeploy's `npm run build` gets it too):
//
//   public/ocr/v5/det.onnx   PP-OCRv5_mobile_det        (PaddlePaddle, HF)
//   public/ocr/v5/rec.onnx   en_PP-OCRv5_mobile_rec     (PaddlePaddle, HF)
//   public/ocr/v5/dict.txt   that model's character list, from its inference.yml
//
// (onnxruntime-web's own .wasm is not here: its bundle references it through
// import.meta.url, so Vite emits it into assets/ with a content hash.)
//
// Too big for git (≈13 MB), so they are fetched and
// checked against a pinned sha256 instead; an existing file that matches is kept.
//
// Why fp32 and these exact files: fp16 conversions failed to load, and an int8
// quantisation misread serials ("SN242550042406" → "SN24255042406") in a check
// against real supplier slips. The fp32 originals read every serial right.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OCR = join(ROOT, "public/ocr/v5");
const HF = "https://huggingface.co/PaddlePaddle";

const FILES = [
  {
    to: "det.onnx",
    url: `${HF}/PP-OCRv5_mobile_det_onnx/resolve/main/inference.onnx`,
    sha256: "a431985659dc921974177a95adcfbb90fd9e51989a5e04d70d0b75f597b6e61d",
  },
  {
    to: "rec.onnx",
    url: `${HF}/en_PP-OCRv5_mobile_rec_onnx/resolve/main/inference.onnx`,
    sha256: "b5f833dfc5d0eb71da397b4efa06ebeee9b431b690a47d6af40d77d8eabc557f",
  },
  {
    to: "rec.yml",
    url: `${HF}/en_PP-OCRv5_mobile_rec_onnx/resolve/main/inference.yml`,
    sha256: "27e91d0582f40168aa218303c76e184bc78fa7a5d105aad0cfbad8458b441067",
  },
];

// Tesseract.js reads the ordinary TEXT on a form — names, departments, item
// names — in any language, Vietnamese diacritics included, which no PaddleOCR
// recogniser covers (checked: none of PP-OCRv5's 13 has ạ/ầ/ễ/ộ/ự…). Language
// packs are 4.0.0_best_int; vie+eng ship by default, the rest are what the
// script probe in lib/textReader.ts tries when a page is not Latin.
const TESS = join(ROOT, "public/ocr/tess");
const TESS_DATA = "https://cdn.jsdelivr.net/npm/@tesseract.js-data";
const LANGS = {
  vie: "2284f610f262a1b19ec8df9f196b9ff6ce38ddb4a66329e998941df4b8961c8d",
  eng: "45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91",
  chi_sim: "b8a23f10c7de500891eb458a8adc9cc58ab7f242f08b7d149f5e9aea4ad5db7c",
  chi_tra: "11fe2610dab05d8a880d02f193ce70203f4c4bbe061b987d5529a2c038a22743",
  jpn: "2b63ebfbf1484de4a08ce53b29ef98a1c17658a93cbd38acb665d7d316d0be88",
  kor: "78c21276ab14c9bb734d83be1055d9fe5469a4e7e977c51ad385be5737e61126",
  tha: "4550a5505184d1b79cf10416d5b19e643001d95411d5e717954dd26feef3ae74",
  rus: "f51f5edc992249ff9b70a227b22f242dfa47b2b1bbc7ae0ea74908640c101f6a",
  ara: "f4746c44b02342dd5b3d4f0198000f47d7c49f1a229e63e0f436c0592dcd9639",
  hin: "f3b6a0d320df38d886178cdd727b90dbf9df3db053adb32bd9cf73f0463cda07",
};

function copyTesseract() {
  mkdirSync(join(TESS, "lang"), { recursive: true });
  const nm = join(ROOT, "node_modules");
  copyFileSync(join(nm, "tesseract.js/dist/worker.min.js"), join(TESS, "worker.min.js"));
  // The worker picks one of these by what the browser supports; each embeds
  // its wasm, so it is one request.
  for (const f of ["tesseract-core-lstm.wasm.js", "tesseract-core-simd-lstm.wasm.js", "tesseract-core-relaxedsimd-lstm.wasm.js"]) {
    copyFileSync(join(nm, "tesseract.js-core", f), join(TESS, f));
  }
}

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

async function fetchChecked({ to, url, sha256 }) {
  const path = join(OCR, to);
  if (existsSync(path) && sha(readFileSync(path)) === sha256) return;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha(buf) !== sha256) throw new Error(`${to}: checksum mismatch — upstream changed, re-verify before pinning`);
  writeFileSync(path, buf);
  console.log(`ocr: fetched ${to} (${(buf.length / 1e6).toFixed(1)} MB)`);
}

/** The `character_dict:` list of inference.yml, one character per line. */
function writeDict() {
  const yml = readFileSync(join(OCR, "rec.yml"), "utf8");
  const lines = yml.slice(yml.indexOf("character_dict:")).split("\n").slice(1);
  const chars = [];
  for (const line of lines) {
    const m = line.match(/^\s*- (.*)$/);
    if (!m) break;
    let v = m[1];
    if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1).replace(/''/g, "'");
    else if (v.startsWith('"') && v.endsWith('"')) v = JSON.parse(v);
    chars.push(v);
  }
  if (chars.length < 90) throw new Error(`dict: only ${chars.length} characters parsed`);
  writeFileSync(join(OCR, "dict.txt"), chars.join("\n") + "\n");
}

mkdirSync(OCR, { recursive: true });
for (const f of FILES) await fetchChecked(f);
writeDict();
copyTesseract();
for (const [lang, sha256] of Object.entries(LANGS)) {
  await fetchChecked({
    to: `../tess/lang/${lang}.traineddata.gz`,
    url: `${TESS_DATA}/${lang}/4.0.0_best_int/${lang}.traineddata.gz`,
    sha256,
  });
}
