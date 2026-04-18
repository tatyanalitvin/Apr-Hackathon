#!/usr/bin/env node
// Verify every REQ-ID flagged as testable in docs/specs/*.md §4 Requirements
// has a matching reference (describe/test/comment) in a test file. Exits 1 if
// any spec-claimed REQ-ID is missing from tests. Set TRACE_VERBOSE=1 for a
// per-REQ coverage dump. Set TRACE_STRICT=1 to also fail on "zombie" REQ-IDs
// referenced in tests but not claimed in any spec §4.

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPECS_DIR = join(REPO_ROOT, "docs/specs");
const TEST_ROOTS = [
  join(REPO_ROOT, "apps/backend/tests"),
  join(REPO_ROOT, "apps/web/src"),
  join(REPO_ROOT, "apps/web/tests"),
  join(REPO_ROOT, "packages/shared"),
  join(REPO_ROOT, "tests"),
];
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|mjs|cjs)$/;
const REQ_RE = /REQ-\d{3,}/g;
const SECTION_4_RE = /^## 4\. Requirements/;
const ANY_H2_RE = /^## /;
const CHECKBOX_RE = /^- \[[ xX]\] /;
const SKIP_SPEC_NAMES = new Set(["_TEMPLATE.md"]);
const SKIP_SPEC_SUFFIX = "-review.md";

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (ent.name === "node_modules" || ent.name === ".next" || ent.name === "dist") continue;
    if (ent.name.startsWith(".") && ent.name !== ".") continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(full));
    else if (ent.isFile()) out.push(full);
  }
  return out;
}

function extractSpecReqs(filepath) {
  const text = readFileSync(filepath, "utf8");
  const lines = text.split("\n");
  const found = [];
  let inReqs = false;
  for (const line of lines) {
    if (SECTION_4_RE.test(line)) {
      inReqs = true;
      continue;
    }
    if (inReqs && ANY_H2_RE.test(line)) break;
    if (!inReqs) continue;
    if (!CHECKBOX_RE.test(line)) continue;
    for (const m of line.matchAll(REQ_RE)) found.push(m[0]);
  }
  return found;
}

function reqNum(id) {
  return parseInt(id.slice(4), 10);
}

const specFiles = readdirSync(SPECS_DIR)
  .filter((f) => f.endsWith(".md"))
  .filter((f) => !SKIP_SPEC_NAMES.has(f) && !f.endsWith(SKIP_SPEC_SUFFIX))
  .map((f) => join(SPECS_DIR, f));

const specReqs = new Map();
for (const spec of specFiles) {
  const name = relative(REPO_ROOT, spec);
  for (const req of extractSpecReqs(spec)) {
    if (!specReqs.has(req)) specReqs.set(req, new Set());
    specReqs.get(req).add(name);
  }
}

const testReqs = new Map();
const scannedTestFiles = [];
for (const root of TEST_ROOTS) {
  for (const file of walk(root)) {
    if (!TEST_FILE_RE.test(file)) continue;
    scannedTestFiles.push(file);
    const text = readFileSync(file, "utf8");
    const name = relative(REPO_ROOT, file);
    for (const m of text.matchAll(REQ_RE)) {
      if (!testReqs.has(m[0])) testReqs.set(m[0], new Set());
      testReqs.get(m[0]).add(name);
    }
  }
}

const missing = [];
const covered = [];
const sortedReqs = [...specReqs.keys()].sort((a, b) => reqNum(a) - reqNum(b));
for (const req of sortedReqs) {
  const specs = [...specReqs.get(req)].sort();
  const tests = testReqs.has(req) ? [...testReqs.get(req)].sort() : [];
  if (tests.length === 0) missing.push({ req, specs });
  else covered.push({ req, specs, tests });
}

const zombies = [];
for (const [req, tests] of testReqs) {
  if (!specReqs.has(req)) zombies.push({ req, tests: [...tests].sort() });
}
zombies.sort((a, b) => reqNum(a.req) - reqNum(b.req));

const c = process.stdout.isTTY
  ? { red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", bold: "\x1b[1m", reset: "\x1b[0m" }
  : { red: "", green: "", yellow: "", bold: "", reset: "" };

console.log(`${c.bold}REQ-ID trace report${c.reset}`);
console.log(`  specs scanned:                       ${specFiles.length}`);
console.log(`  test files scanned:                  ${scannedTestFiles.length}`);
console.log(`  unique REQs claimed in spec §4:      ${specReqs.size}`);
console.log(
  `  REQs with ≥1 test reference:         ${c.green}${covered.length}${c.reset}`,
);
console.log(
  `  REQs missing from tests:             ${missing.length ? c.red : c.green}${missing.length}${c.reset}`,
);
if (zombies.length) {
  console.log(
    `  REQs in tests but not in spec §4:    ${c.yellow}${zombies.length}${c.reset}`,
  );
}
console.log("");

if (missing.length) {
  console.log(`${c.bold}${c.red}Missing (claimed in spec §4, no test reference):${c.reset}`);
  for (const { req, specs } of missing) {
    console.log(`  ${c.red}${req}${c.reset}  claimed in: ${specs.join(", ")}`);
  }
  console.log("");
}

if (zombies.length) {
  console.log(`${c.bold}${c.yellow}In tests but not claimed in any spec §4:${c.reset}`);
  for (const { req, tests } of zombies) {
    console.log(`  ${c.yellow}${req}${c.reset}  in: ${tests.join(", ")}`);
  }
  console.log("");
}

if (process.env.TRACE_VERBOSE) {
  console.log(`${c.bold}Covered:${c.reset}`);
  for (const { req, specs, tests } of covered) {
    console.log(
      `  ${c.green}${req}${c.reset}  ${specs.join(", ")} → ${tests.length} test file(s)`,
    );
  }
  console.log("");
}

const strictFail = process.env.TRACE_STRICT && zombies.length > 0;
process.exit(missing.length === 0 && !strictFail ? 0 : 1);
