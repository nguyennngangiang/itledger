// Every `{placeholder}` in an English string must survive into its shuffled twin.
//
// This is the failure mode a translation pass actually has: a dropped `{n}` does
// not crash, it silently renders "things to deal with" with no number, and an
// invented `{count}` renders the literal braces. With ~460 hand-written entries
// neither is findable by eye.
//
//   node scripts/check-placeholders.mjs   (exit 1 on any mismatch)
import { readFileSync } from "node:fs";

const read = (p) =>
  readFileSync(new URL(`../src/i18n/${p}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );

/** key -> Set of {placeholder} names, for one catalog-shaped source. */
function placeholders(src, valueOf) {
  const out = new Map();
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^ {2}"([\w.]+)":/);
    if (!m) continue;
    // Values wrap: join this line and the next few until the entry closes.
    const chunk = lines.slice(i, i + 4).join("\n");
    const value = valueOf(chunk);
    if (value === null) continue;
    out.set(m[1], new Set([...value.matchAll(/\{(\w+)\}/g)].map((p) => p[1])));
  }
  return out;
}

const en = placeholders(read("catalog.ts"), (chunk) => {
  const v = chunk.match(/^ {2}"[\w.]+":\s*\n?\s*"((?:[^"\\]|\\.)*)"/);
  return v ? v[1] : null;
});

// A scramble entry is `["lang", "text"]`, possibly wrapped across lines.
const sc = placeholders(read("scramble.ts"), (chunk) => {
  const v = chunk.match(/\[\s*"\w+",\s*\n?\s*"((?:[^"\\]|\\.)*)"/);
  return v ? v[1] : null;
});

const problems = [];
for (const [key, want] of en) {
  const got = sc.get(key);
  if (!got) continue; // missing entries are reported by check-i18n.mjs
  for (const p of want) {
    if (!got.has(p)) problems.push(`${key}: shuffled version drops {${p}}`);
  }
  for (const p of got) {
    if (!want.has(p)) problems.push(`${key}: shuffled version invents {${p}}`);
  }
}

console.log(`checked ${sc.size} shuffled entries against ${en.size} English`);
if (problems.length) {
  console.error(`\n${problems.length} placeholder mismatches:`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log("all placeholders match");
