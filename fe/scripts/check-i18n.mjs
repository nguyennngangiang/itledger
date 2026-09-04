// Coverage report for the translation catalog.
//
// TypeScript already refuses a SCRAMBLE key that isn't in EN (the type is
// `Partial<Record<Key, …>>`), so the compiler covers orphans. What it cannot tell
// you is the useful part: which keys still have no shuffled version, whether any
// key is defined but never used, and how much hardcoded text is left. With ~450
// keys none of that is checkable by eye.
//
//   node scripts/check-i18n.mjs          report
//   node scripts/check-i18n.mjs --strict exit 1 if anything is missing (for CI)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = new URL("../src", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const strict = process.argv.includes("--strict");

const read = (p) => readFileSync(join(SRC, p), "utf8");

/** Keys are the quoted left-hand sides of a `"a.b": …` entry. */
function keysOf(source) {
  return new Set([...source.matchAll(/^\s{2}"([\w.]+)":/gm)].map((m) => m[1]));
}

const en = keysOf(read("i18n/catalog.ts"));
const scrambled = keysOf(read("i18n/scramble.ts"));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full) && !full.includes(`${"i18n"}`)) out.push(full);
  }
  return out;
}

const files = walk(SRC);
const used = new Set();
for (const f of files) {
  const src = readFileSync(f, "utf8");
  // Any literal that happens to be a real key counts — covers t("x"), <T k="x">,
  // keys parked in constants (`label: "nav.device"`), and keys inside ternaries.
  for (const m of src.matchAll(/"([a-z][\w]*(?:\.[\w]+)+)"/g)) {
    if (en.has(m[1])) used.add(m[1]);
  }
  // Keys assembled in a template literal, e.g. `page.${page}.title` — match every
  // catalog key with that prefix and suffix.
  for (const m of src.matchAll(/`([\w.]*)\$\{[^`}]+\}([\w.]*)`/g)) {
    const [, head, tail] = m;
    if (!head && !tail) continue;
    for (const k of en) if (k.startsWith(head) && k.endsWith(tail)) used.add(k);
  }
}

const missingScramble = [...en].filter((k) => !scrambled.has(k)).sort();
// A `.one` sibling is picked at runtime by the plural rule, never written at a
// call site — it counts as used whenever its base key is.
const unused = [...en]
  .filter((k) => !used.has(k) && !(k.endsWith(".one") && used.has(k.slice(0, -4))))
  .sort();

// Values that must never become translatable — see i18n/exclusions.ts. These are
// compared against in code or stored in the database, so a translation changes
// behaviour rather than appearance.
const banned = [
  ...(read("i18n/exclusions.ts").match(/^\s{4}"([^"]+)",$/gm) || []).map((l) =>
    l.trim().replace(/^"|",$/g, ""),
  ),
  "—",
];
const catalogValues = new Set(
  [...read("i18n/catalog.ts").matchAll(/^\s{2}"[\w.]+":\s*"([^"]*)"/gm)].map(
    (m) => m[1],
  ),
);
const leaked = banned.filter((v) => catalogValues.has(v));

// Rough progress signal: source lines still holding Vietnamese text.
const viFiles = files
  .map((f) => [
    relative(SRC, f),
    (readFileSync(f, "utf8").match(/[àáâãèéêìíòóôõùúýăđĩũơưạ-ỹ]/gi) || []).length,
  ])
  .filter(([, n]) => n > 0)
  .sort((a, b) => b[1] - a[1]);

console.log(`catalog keys      ${en.size}`);
console.log(`with a shuffle    ${en.size - missingScramble.length}`);
console.log(`no shuffle yet    ${missingScramble.length}`);
console.log(`defined but unused ${unused.length}`);
if (unused.length) console.log("  " + unused.join("\n  "));
if (missingScramble.length && process.argv.includes("--list")) {
  console.log("\nmissing shuffle:\n  " + missingScramble.join("\n  "));
}
if (viFiles.length) {
  console.log(`\nfiles still holding Vietnamese text (${viFiles.length}):`);
  for (const [f, n] of viFiles) console.log(`  ${String(n).padStart(5)}  ${f}`);
}

// The exported workbook's column headings must stay English — the file leaves the
// app, and ImportDevicesModal's HEADER_ALIASES matches on those names, so
// export-then-reimport only round-trips while they are unchanged. Guarded by
// module rather than by string, because "Serial Number" and "Buy Date" are also
// real on-screen headings that SHOULD shuffle.
const exporter = read("lib/exportDevices.ts");
const exporterTranslates =
  /from "\.\.\/i18n\//.test(exporter) || /\bt\(\s*"/.test(exporter);
if (exporterTranslates) {
  console.log(
    "\nlib/exportDevices.ts reaches the translation layer — its column headings " +
      "must stay English or export/reimport stops round-tripping. " +
      "See i18n/exclusions.ts.",
  );
}

if (leaked.length) {
  console.log(
    `\nDO-NOT-TRANSLATE value found in the catalog (${leaked.length}) — ` +
      "code compares against these or stores them; see i18n/exclusions.ts:",
  );
  for (const v of leaked) console.log(`  ${v}`);
}

// Both of these are live behaviour bugs, not to-dos.
if (leaked.length || exporterTranslates) process.exit(1);
if (strict && (missingScramble.length || unused.length || viFiles.length)) {
  process.exit(1);
}
