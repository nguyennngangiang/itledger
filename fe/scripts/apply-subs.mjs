// Apply a batch of exact literal substitutions described by a JSON file.
//
// Scratch tooling for large mechanical edits. Doing them through `node -e` means
// every pattern crosses bash single-quoting, JS string escaping and JSX quotes,
// and a mis-escape silently becomes a "no match" that is slow to diagnose. A JSON
// spec has one level of escaping instead of three.
//
//   node scripts/apply-subs.mjs spec.json
//
// Spec shape: { "<file>": [ ["find", "replace"], … ], … }
// All-or-nothing per file: if any pattern is missing, that file is left untouched
// and the run exits non-zero naming what failed.
import { readFileSync, writeFileSync } from "node:fs";

const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
const failures = [];

for (const [file, subs] of Object.entries(spec)) {
  let src;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    failures.push(`${file}: cannot read`);
    continue;
  }
  // Several files in this tree are CRLF. Patterns are written with plain \n, so
  // normalise before matching and restore the file's own ending afterwards —
  // otherwise every multi-line pattern silently fails to match.
  const crlf = src.includes("\r\n");
  let next = crlf ? src.replace(/\r\n/g, "\n") : src;
  let ok = true;
  for (const [find, replace] of subs) {
    if (!next.includes(find)) {
      failures.push(`${file}: no match for ${JSON.stringify(find.slice(0, 70))}`);
      ok = false;
      break;
    }
    next = next.split(find).join(replace);
  }
  if (ok) {
    writeFileSync(file, crlf ? next.replace(/\n/g, "\r\n") : next);
    console.log(`ok   ${file} (${subs.length})${crlf ? " [crlf]" : ""}`);
  }
}

if (failures.length) {
  console.error("\n" + failures.join("\n"));
  process.exit(1);
}
