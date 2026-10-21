// node --experimental-strip-types --test scripts/device3d-kind.test.mjs
//
// Rows below are shaped like the LIVE ledger (types in mixed case, ACCESSORY
// holding mice, cables and an iPad, LG monitors sized only in the name).
import assert from "node:assert/strict";
import { test } from "node:test";
import { kindOf, inchesOf, finishOf, ledOf, osOf, monitorsInSet, variantOf, setTower } from "../src/lib/device3d/kind.ts";

test("big types, any case", () => {
  assert.equal(kindOf({ type: "LAPTOP" }), "laptop");
  assert.equal(kindOf({ type: "Laptop" }), "laptop");
  assert.equal(kindOf({ type: "MONITOR", name: 'LG Monitor 27"' }), "monitor");
  assert.equal(kindOf({ type: "Tablet" }), "tablet");
  assert.equal(kindOf({ type: "DESKTOP", brand: "HP", cpu: "Core I5" }), "desktop");
  assert.equal(kindOf({ type: "Workstation" }), "desktop");
});

test("Apple silicon desktop is a mini PC", () => {
  assert.equal(kindOf({ type: "DESKTOP", brand: "Apple", cpu: "Apple M1" }), "minipc");
});

test("ACCESSORY is decided by the name", () => {
  const k = (name) => kindOf({ type: "ACCESSORY", name });
  assert.equal(k("Chuột Logitech B100"), "mouse");
  assert.equal(k("Bàn phím cơ DareU EK75"), "keyboard");
  assert.equal(k("HDMI ugreen 10109 dài 5m"), "cable");
  assert.equal(k("Displayport to HDMI"), "cable");
  assert.equal(k("Cáp truyền dữ liệu"), "cable");
  assert.equal(k("Hub ugreen 7in1"), "hub");
  assert.equal(k("SSD 512GB SAMSUNG"), "ssd");
  assert.equal(k("Ipad 11-inch 128GB - blue"), "tablet");
  assert.equal(k("22inch Monitor LG"), "monitor");
  assert.equal(k("Main board Asus - Core i5 - 32GB RAM"), "desktop");
  assert.equal(k("Thứ gì đó lạ"), "other");
  assert.equal(kindOf({}), "other");
});

test("rows the first version got wrong on the live ledger", () => {
  // a PC whose spec mentions an SSD was drawn as a bare drive
  assert.equal(kindOf({ type: "ACCESSORY", brand: "HP", name: "HP core i3 ram 8gb ssd 256gb / 22inch Monitor LG" }), "set");
  assert.equal(kindOf({ type: "ACCESSORY", brand: "HP", name: "HP core i3 ram 8gb ssd 256gb" }), "desktop");
  // PC + screen filed as MONITOR
  assert.equal(kindOf({ type: "MONITOR", brand: "HP", name: 'HP Core i3 - 8GB - 256GB / 22" LG Monitor' }), "set");
  assert.equal(kindOf({ type: "MONITOR", brand: "HP", name: 'HP-core i5-8GB-1TB / LG Monitor 22"' }), "set");
  assert.equal(kindOf({ type: "MONITOR", brand: "HP", name: 'HP i5 8GB 256GB/22" LG Monitor' }), "set");
  const asus = 'Main board Asus - Core i5 - 32GB RAM- 1TB SSD - GTX 5060 8GB / 2 27" LG Monitor / HP Core i5 - 16GB';
  assert.equal(kindOf({ type: "ACCESSORY", brand: "ASUS", name: asus }), "set");
  assert.equal(monitorsInSet({ name: asus }), 2);
  assert.equal(monitorsInSet({ name: 'HP i5 8GB 256GB/22" LG Monitor' }), 1);
  // a printer filed as LAPTOP
  assert.equal(kindOf({ type: "LAPTOP", brand: "HP", name: "Máy in laser đen trắng HP 4003dn 2Z609A" }), "printer");
  // plain monitors and drives stay what they are
  assert.equal(kindOf({ type: "MONITOR", name: "LG 24U411A-B 24\" Monitor" }), "monitor");
  assert.equal(kindOf({ type: "ACCESSORY", name: "SSD 512GB" }), "ssd");
  assert.equal(kindOf({ type: "Tablet", name: "Poco Pad C1 Wifi 6GB 128GB Xanh dương" }), "tablet");
});

test("screen size from the name", () => {
  assert.equal(inchesOf({ name: 'LG Monitor 27"' }), 27);
  assert.equal(inchesOf({ name: '24" LG Monitor' }), 24);
  assert.equal(inchesOf({ name: "22inch Monitor LG" }), 22);
  assert.equal(inchesOf({ name: "Ipad 11-inch 128GB" }), 11);
  assert.equal(inchesOf({ name: "HP Core I5 8GB" }), null);
});

test("finish by brand, then by a brand word in the name", () => {
  assert.equal(finishOf({ brand: "HP" }).logo, "hp");
  assert.equal(finishOf({ brand: "Asus" }).logo, "ASUS");
  assert.equal(finishOf({ brand: "LENOVO" }).accent, "#e2231a");
  assert.equal(finishOf({ brand: null, name: "Chuột Logitech B100" }).logo, "logi");
  assert.equal(finishOf({ brand: null, name: "Hub ugreen 7in1" }).logo, "UGREEN");
  assert.equal(finishOf({ brand: "Intel" }).logo, "Intel");
  assert.equal(finishOf({}).logo, "");
});

test("LED and OS", () => {
  assert.equal(ledOf("active"), "#38e07b");
  assert.equal(ledOf("in_stock"), null);
  assert.equal(osOf({ os: "Windows 11 Home SL" }), "windows");
  assert.equal(osOf({ os: "macOS" }), "mac");
  assert.equal(osOf({ os: "Android 16" }), "android");
  assert.equal(osOf({ os: null }), "none");
});

test("product family from the name", () => {
  const v = (d) => variantOf(d);
  assert.equal(v({ type: "LAPTOP", brand: "HP", name: "HP 15-fd0235TU (i5-16GB-512GB)" }), "hp15");
  assert.equal(v({ type: "LAPTOP", brand: "HP", name: "HP Core I5 8GB" }), "hp15");
  assert.equal(v({ type: "LAPTOP", brand: "ASUS", name: "Asus vivobook 15 X1502V (i7-16GB-512GB)" }), "vivobook");
  assert.equal(v({ type: "LAPTOP", brand: "DELL", name: "Dell inspiron16 (i7-16GB-1TB)" }), "inspiron");
  assert.equal(v({ type: "LAPTOP", brand: "Apple", name: "Apple Apple M1", cpu: "Apple M1" }), "macbook");
  assert.equal(v({ type: "LAPTOP", brand: "LENOVO", name: "LENOVO RYZEN 5 16GB" }), "laptop");
  assert.equal(v({ type: "MONITOR", brand: "LG", name: 'LG 24U411A-B 24" Monitor' }), "lg");
  assert.equal(v({ type: "MONITOR", brand: "SAMSUNG", name: 'SAMSUNG Monitor 27"' }), "samsung");
  assert.equal(v({ type: "DESKTOP", brand: "GIGABYTE", name: "GIGABYTE Core I7 16GB" }), "gaming");
  assert.equal(v({ type: "DESKTOP", brand: "DELL", name: "DELL Core I5 16GB" }), "dell-tower");
  assert.equal(v({ type: "DESKTOP", brand: "HP", name: "HP Core I5 8GB" }), "hp-tower");
  assert.equal(v({ type: "DESKTOP", brand: "Intel", name: "Intel Core i7 16GB" }), "tower");
  assert.equal(v({ type: "ACCESSORY", name: "Chuột Logitech B100" }), "b100");
  assert.equal(v({ type: "ACCESSORY", name: "Bàn phím cơ DareU EK75" }), "ek75");
  assert.equal(v({ type: "LAPTOP", brand: "HP", name: "Máy in laser đen trắng HP 4003dn 2Z609A" }), "laserjet");
  assert.equal(v({ type: "ACCESSORY", name: "Ipad 11-inch 128GB - blue" }), "ipad");
  assert.equal(v({ type: "Tablet", name: "Poco Pad C1 Wifi 6GB 128GB Xanh dương" }), "pocopad");
  // a set: LG screen, HP tower
  const set = { type: "MONITOR", brand: "HP", name: 'HP Core i3 - 8GB - 256GB / 22" LG Monitor' };
  assert.equal(variantOf(set), "lg");
  assert.equal(setTower(set), "hp-tower");
  assert.equal(setTower({ name: 'Main board Asus - Core i5 - 32GB RAM- 1TB SSD - GTX 5060 8GB / 2 27" LG Monitor / HP Core i5 - 16GB' }), "gaming");
});
