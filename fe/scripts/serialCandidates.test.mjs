// node --experimental-strip-types --test scripts/serialCandidates.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { Stabilizer, serialCandidates } from "../src/lib/serialCandidates.ts";

const values = (lines, ex) => serialCandidates(lines, ex).map((c) => c.value);

test("strips the S/N label but keeps a serial that starts with SN", () => {
  assert.deepEqual(values(["S/N: 5CD0337TB"]), ["5CD0337TB"]);
  assert.deepEqual(values(["SN242550042406"]), ["SN242550042406"]);
  assert.equal(serialCandidates(["SN: W2N0CX01B92106A"])[0].labelled, true);
});

test("a label on its own line marks the next line", () => {
  const c = serialCandidates(["S/N", "W3N0CV14732913B"]);
  assert.deepEqual(c.map((x) => [x.value, x.labelled]), [["W3N0CV14732913B", true]]);
});

test("ratings, dates, words and known SKUs are not serials", () => {
  assert.deepEqual(values(["19V 3.42A 65W", "12/08/2025", "VIVOBOOK", "MADE IN CHINA"]), []);
  assert.deepEqual(values(["U7 255H/32GB RAM/1TB"]), []);
  assert.deepEqual(values(["LTAU1085 W3N0CV147309132"], new Set(["LTAU1085"])), ["W3N0CV147309132"]);
});

test("an unlabelled short code is a model fragment, a labelled one is kept", () => {
  assert.deepEqual(values(["ZenBook ZBUX5CA"]), []);
  assert.deepEqual(values(["S/N: AB12CD"]), ["AB12CD"]);
});

test("a value shows only after two agreeing frames", () => {
  const s = new Stabilizer(2);
  assert.deepEqual(s.push(["A1B2C3D4"]), []);
  assert.deepEqual(s.push(["A1B2C3D4", "X9"]), ["A1B2C3D4"]);
  // A1B2C3D4 dropped out of frame 3, so its streak is gone; X9 now has two.
  assert.deepEqual(s.push(["X9"]), ["X9"]);
  assert.deepEqual(s.push(["A1B2C3D4"]), []);
});
