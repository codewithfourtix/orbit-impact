/**
 * Pure unit tests for the unified-diff parser. No Orbit required — run anywhere:
 *   npm run build && node dist/difftest.js   (or: npx tsx src/difftest.ts)
 */
import { parseUnifiedDiff } from "./diff.js";
import assert from "node:assert/strict";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

check("add + delete record the right new-side line", () => {
  const diff = [
    "diff --git a/shopfast/orders.py b/shopfast/orders.py",
    "--- a/shopfast/orders.py",
    "+++ b/shopfast/orders.py",
    "@@ -6,4 +6,4 @@ from shopfast.pricing import apply_discount",
    " def order_total(items, discount_pct=0, service_fee=0):",
    '     """Sum the lines."""',
    "-    subtotal = sum(line_total(i) for i in items)",
    "+    subtotal = round(sum(line_total(i) for i in items), 2)",
    "     discounted = apply_discount(subtotal, discount_pct)",
  ].join("\n");
  const files = parseUnifiedDiff(diff);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "shopfast/orders.py");
  assert.deepEqual(files[0].changedLines, [8]); // both - and + land on new line 8
});

check("strips a/ b/ prefixes and trailing tab timestamps", () => {
  const diff = [
    "--- a/src/x.py\t2024-01-01 00:00:00",
    "+++ b/src/x.py\t2024-01-01 00:00:01",
    "@@ -1,1 +1,2 @@",
    " a = 1",
    "+b = 2",
  ].join("\n");
  const files = parseUnifiedDiff(diff);
  assert.equal(files[0].path, "src/x.py");
  assert.deepEqual(files[0].changedLines, [2]);
});

check("skips deletions whose new side is /dev/null", () => {
  const diff = [
    "--- a/gone.py",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-line one",
    "-line two",
  ].join("\n");
  assert.equal(parseUnifiedDiff(diff).length, 0);
});

check("tracks multiple files and multiple hunks independently", () => {
  const diff = [
    "+++ b/a.py",
    "@@ -10,1 +10,2 @@",
    " keep",
    "+added at 11",
    "@@ -50,1 +51,2 @@",
    " keep",
    "+added at 52",
    "+++ b/b.py",
    "@@ -1,1 +1,1 @@",
    "-old",
    "+new",
  ].join("\n");
  const files = parseUnifiedDiff(diff);
  const a = files.find((f) => f.path === "a.py")!;
  const b = files.find((f) => f.path === "b.py")!;
  assert.deepEqual(a.changedLines, [11, 52]);
  assert.deepEqual(b.changedLines, [1]);
});

check("ignores '\\ No newline at end of file' markers", () => {
  const diff = [
    "+++ b/c.py",
    "@@ -1,1 +1,1 @@",
    "-old",
    "\\ No newline at end of file",
    "+new",
    "\\ No newline at end of file",
  ].join("\n");
  assert.deepEqual(parseUnifiedDiff(diff)[0].changedLines, [1]);
});

check("handles a hunk header without explicit line counts", () => {
  const diff = ["+++ b/d.py", "@@ -3 +3 @@", "-x", "+y"].join("\n");
  assert.deepEqual(parseUnifiedDiff(diff)[0].changedLines, [3]);
});

console.log(`\n${passed} diff-parser test(s) passed.`);
