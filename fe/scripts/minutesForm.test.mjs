// node --experimental-strip-types --test scripts/minutesForm.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { extract, toRows } from "../src/lib/minutesFields.ts";
import { dropStale, emptyForm, mergeExtracted, settle, toParsed } from "../src/lib/minutesForm.ts";

const rows = toRows(JSON.parse(readFileSync(new URL("./fixtures/minutes-internal.cells.json", import.meta.url), "utf8")));
const users = new Map([["VPHN291", { name: "Ngô Minh Tuấn", team: "IT" }], ["VP4", { name: "Hồ Thị Thu Thủy", team: "OPD" }]]);

test("the same frame twice changes nothing — and returns the same object", () => {
  const e = extract(rows, new Set(users.keys()));
  const once = mergeExtracted(emptyForm(), e, users);
  const twice = settle(once, mergeExtracted(once, e, users));
  assert.equal(twice, once);
});

test("codes in the user table settle name and team from the database", () => {
  const f = mergeExtracted(emptyForm(), extract(rows, new Set(users.keys())), users);
  const b = f.parties.find((p) => p.label === "B");
  assert.deepEqual([b.name.value, b.name.source, b.dept.value], ["Hồ Thị Thu Thủy", "db", "OPD"]);
});

test("a camera-only serial no longer seen is withdrawn; the record reaches the plan shape", () => {
  const f = mergeExtracted(emptyForm(), extract(rows, new Set(users.keys())), users);
  const kept = dropStale(f, new Set(["YOD-001"]));
  assert.deepEqual(kept.items.flatMap((i) => i.serials), ["YOD-001"]);
  const parsed = toParsed(kept);
  assert.deepEqual(parsed.parties.map((p) => p.code), ["VPHN291", "VP4"]);
  assert.deepEqual(parsed.items.map((i) => i.serial), ["YOD-001"]);
  assert.equal(parsed.handover_date, "2026-09-25");
});
