// Rasterises public/icon.svg into the PNG + ICO variants the browser wants.
//
//   npm run icons
//
// Deliberately NOT part of `npm run build`: the outputs are static files that
// live in public/ and are committed, so a production build must never depend on
// a native module. Re-run this by hand whenever icon.svg changes.
//
// Two things this has to get right.
//
// 1. Sharp renders an SVG at its INTRINSIC size (via librsvg) and only then
//    resizes the raster. Handing it a 32px source and asking for 512 upscales a
//    32px bitmap — the classic blurry-icon bug. So the width/height attributes
//    are rewritten per target before the buffer reaches sharp. The viewBox is
//    untouched, so nothing about the drawing changes.
//
// 2. Sharp cannot write ICO. It does not need to: PNG-inside-ICO has been legal
//    since Vista and every browser and Explorer reads it, and the container is
//    a 6-byte header plus one 16-byte record per image. That is cheaper than a
//    dependency, so `ico()` below writes it directly.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const source = readFileSync(join(PUBLIC, "icon.svg"), "utf8");

// Matched once up front: a silent miss here would ship blurry icons rather than
// fail, and `sized === source` cannot detect it (rewriting 32 -> 32 is a no-op).
const DIMENSIONS = /(<svg[^>]*?)\bwidth="\d+"\s+height="\d+"/;
if (!DIMENSIONS.test(source)) throw new Error("icon.svg: no width/height on <svg>");

/** The same drawing, declared at `size` so librsvg rasterises it natively. */
const at = (size) =>
  Buffer.from(source.replace(DIMENSIONS, `$1width="${size}" height="${size}"`));

const png = (size) =>
  sharp(at(size)).resize(size, size).png({ compressionLevel: 9 }).toBuffer();

/**
 * ICONDIR (6 bytes) + ICONDIRENTRY (16 bytes each) + the PNG payloads.
 * A width or height of 0 means 256; nothing here is that big, but the encoding
 * is part of the format so it is spelled out rather than assumed.
 */
function ico(images) {
  const dir = Buffer.alloc(6 + 16 * images.length);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type: 1 = icon
  dir.writeUInt16LE(images.length, 4);

  let offset = dir.length;
  images.forEach(({ size, buf }, i) => {
    const p = 6 + 16 * i;
    dir.writeUInt8(size === 256 ? 0 : size, p); // width
    dir.writeUInt8(size === 256 ? 0 : size, p + 1); // height
    dir.writeUInt8(0, p + 2); // palette entries (0 = no palette)
    dir.writeUInt8(0, p + 3); // reserved
    dir.writeUInt16LE(1, p + 4); // colour planes
    dir.writeUInt16LE(32, p + 6); // bits per pixel
    dir.writeUInt32LE(buf.length, p + 8);
    dir.writeUInt32LE(offset, p + 12);
    offset += buf.length;
  });

  return Buffer.concat([dir, ...images.map((i) => i.buf)]);
}

const write = (name, buf) => {
  writeFileSync(join(PUBLIC, name), buf);
  console.log(`  ${name.padEnd(22)} ${String(buf.length).padStart(7)} bytes`);
};

console.log("icon.svg ->");

for (const [name, size] of [
  ["apple-touch-icon.png", 180],
  ["icon-192.png", 192],
  ["icon-512.png", 512],
]) {
  write(name, await png(size));
}

const sizes = [16, 32, 48];
write(
  "favicon.ico",
  ico(await Promise.all(sizes.map(async (size) => ({ size, buf: await png(size) })))),
);
