// node --experimental-strip-types --test scripts/minutesFields.test.mjs
//
// Fixtures are REAL on-device OCR output (PaddleOCR line boxes + Tesseract
// vie+eng text) of: a company-template internal record, and the top of Hacom's
// supplier handover minutes from devices.pdf — wrinkles and misreads included
// ("Hồ Thi Thu Thủy", "PAU TU", "IT C").
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { extract, fold, mayReplace, toRows } from "../src/lib/minutesFields.ts";

const rows = (name) =>
  toRows(JSON.parse(readFileSync(new URL(`./fixtures/minutes-${name}.cells.json`, import.meta.url), "utf8")));

test("fold keeps every index", () => {
  const s = "Hồ Thị Thu Thủy — Đặng";
  assert.equal(fold(s).length, s.length);
  assert.equal(fold(s), "ho thi thu thuy — dang");
});

test("internal record: sides, codes, date, place, devices", () => {
  const e = extract(rows("internal"), new Set(["VPHN291", "VP4"]));
  assert.ok(e.kindVotes.internal > e.kindVotes.supplier);
  assert.equal(e.date, "2026-09-25");
  assert.equal(e.place, "Văn phòng Hà Nội");
  assert.deepEqual(
    e.parties.map((p) => [p.label, p.role, p.code, p.name]),
    [["A", "giver", "VPHN291", "Ngô Minh Tuấn"], ["B", "receiver", "VP4", "Hồ Thi Thu Thủy"]],
  );
  assert.deepEqual(e.items.map((i) => [i.item, i.serials]), [
    ["Laptop Intel Core i7 16GB", ["YOD-001"]],
    ["Chuột không day Logitech B100", ["2601APY5DCS9"]],
  ]);
});

test("supplier minutes: buyer/seller companies, wrapped item name, serials under it", () => {
  const e = extract(rows("hacom"));
  assert.ok(e.kindVotes.supplier > e.kindVotes.internal);
  const [a, b] = e.parties;
  assert.equal(a.role, "buyer");
  assert.equal(a.company, "CÔNG TY TNHH YIC ONE");
  assert.equal(a.phone, "0934168188");
  assert.equal(b.role, "seller");
  assert.match(b.company, /HACOM/);
  const asus = e.items.find((i) => i.item.startsWith("Laptop Asus ZenBook"));
  assert.deepEqual(asus.serials, ["W2N0CX01B92106A", "W2N0CX01B889063"]);
  // Spec fragments and "Mới 100%" never become serials.
  assert.ok(e.items.every((i) => i.serials.every((s) => !/UX3405|255H|MI100/.test(s))));
});

test("a person's edit and a database match are never overwritten", () => {
  const ocr = { value: "x", source: "ocr", conf: 0.5 };
  assert.equal(mayReplace({ value: "typed", source: "user", conf: 1 }, { value: "y", source: "claude", conf: 1 }), false);
  assert.equal(mayReplace({ value: "Ngô Minh Tuấn", source: "db", conf: 1 }, { value: "y", source: "claude", conf: 1 }), false);
  assert.equal(mayReplace(ocr, { value: "y", source: "claude", conf: 0.1 }), true);
  assert.equal(mayReplace(ocr, { value: "y", source: "ocr", conf: 0.52 }), false);
  assert.equal(mayReplace(ocr, { value: "y", source: "ocr", conf: 0.8 }), true);
});
